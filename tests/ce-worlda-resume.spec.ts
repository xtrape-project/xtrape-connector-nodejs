import { describe, expect, it } from "vitest";
import { CeLongPollLoop } from "../src/index";
import type { StreamDelivery } from "@xtrape/contracts";

/**
 * Transient-failure RESUME behavior of the World A long-poll loop
 * (release-review gap, 0.7.6): the loop's safety on reconnect (server-side
 * redelivery + client dedupe) was already tested in ce-worlda.spec.ts, but the
 * resume path itself — network error or non-fatal 5xx → onWarn → backoff →
 * next poll proceeds and deliveries execute — had no direct assertion.
 */

const transport = { contractVersion: 1, mode: "LONG_POLL", waitMs: 1_000, maxBatch: 16 } as const;

function commandDelivery(commandId: string): StreamDelivery {
  return {
    kind: "COMMAND",
    deliveryId: `dlv_${commandId}.1`,
    attempt: 1,
    command: {
      operation: "EXECUTE",
      commandId,
      actionName: "ping",
      input: { probe: 1 },
      issuedAt: new Date().toISOString(),
      timeoutSeconds: 60,
    },
  } as StreamDelivery;
}

type ScriptStep =
  | { kind: "reject"; message: string }
  | { kind: "status"; status: number }
  | { kind: "batch"; deliveries: StreamDelivery[] };

/** Minimal fake: scripted poll outcomes (including thrown fetch errors); ack recorded; script exhaustion hangs like the real Platform. */
function fakePollServer(script: ScriptStep[]) {
  const acks: string[][] = [];
  let polls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/deliveries/poll")) {
      polls += 1;
      const step = script.shift();
      if (!step) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (step.kind === "reject") throw new Error(step.message);
      if (step.kind === "status") return new Response(null, { status: step.status });
      return new Response(JSON.stringify({ contractVersion: 1, deliveries: step.deliveries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/deliveries/ack")) {
      acks.push((JSON.parse(String(init?.body)) as { deliveryIds: string[] }).deliveryIds);
      return new Response(JSON.stringify({ acked: acks.at(-1), unknown: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected call: ${u}`);
  }) as typeof fetch;
  return { fetchImpl, acks, pollCount: () => polls };
}

async function until(cond: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startLoop(srv: { fetchImpl: typeof fetch }, executed: string[], warns: string[]) {
  const loop = new CeLongPollLoop({
    serverUrl: "http://srv:3000",
    instanceId: "inst-resume",
    transport,
    authHeaders: () => ({ "x-xtrape-access-token": "t" }),
    fetchImpl: srv.fetchImpl,
    handlers: {
      onExecute: (c: { commandId: string }) => void executed.push(c.commandId),
      onReview: () => undefined,
      onCancel: () => undefined,
      onMessage: () => undefined,
      onWarn: (m: string) => void warns.push(m),
      onFatal: () => {
        throw new Error("transient failure must not be fatal");
      },
    },
  });
  void loop.start();
  return loop;
}

describe("CeLongPollLoop transient-failure resume", () => {
  it("recovers from a network error: warns, backs off, then the next poll delivers and executes", async () => {
    const srv = fakePollServer([
      { kind: "reject", message: "socket hang up" },
      { kind: "batch", deliveries: [commandDelivery("cmd_after_neterr")] },
    ]);
    const executed: string[] = [];
    const warns: string[] = [];
    const loop = startLoop(srv, executed, warns);

    await until(() => srv.acks.length >= 1);
    await loop.stop();

    expect(executed).toEqual(["cmd_after_neterr"]); // delivery after the drop still executes
    expect(srv.acks[0]).toEqual(["dlv_cmd_after_neterr.1"]);
    expect(srv.pollCount()).toBeGreaterThanOrEqual(2); // it re-polled after the failure
    expect(warns.some((w) => w.includes("poll failed") && w.includes("socket hang up"))).toBe(true);
    expect(warns.some((w) => w.includes("backing off"))).toBe(true);
  }, 15_000);

  it("recovers from a non-fatal 5xx the same way, without treating it as fatal", async () => {
    const srv = fakePollServer([
      { kind: "status", status: 503 },
      { kind: "batch", deliveries: [commandDelivery("cmd_after_503")] },
    ]);
    const executed: string[] = [];
    const warns: string[] = [];
    const loop = startLoop(srv, executed, warns);

    await until(() => srv.acks.length >= 1);
    await loop.stop();

    expect(executed).toEqual(["cmd_after_503"]);
    expect(warns.some((w) => w.includes("poll returned 503"))).toBe(true);
  }, 15_000);

  it("resets the backoff after a successful poll instead of accumulating it across incidents", async () => {
    // failure -> success -> failure -> success. The loop's own warn messages
    // carry the backoff value it is about to sleep ("backing off <n>ms"), so
    // the assertion is deterministic and immune to slow CI wall clocks: with
    // the reset both incidents back off the INITIAL 1000ms; without it the
    // second incident would announce 2000ms.
    const srv = fakePollServer([
      { kind: "reject", message: "drop-1" },
      { kind: "batch", deliveries: [commandDelivery("cmd_r1")] },
      { kind: "status", status: 502 },
      { kind: "batch", deliveries: [commandDelivery("cmd_r2")] },
    ]);
    const executed: string[] = [];
    const warns: string[] = [];
    const loop = startLoop(srv, executed, warns);

    await until(() => srv.acks.length >= 2);
    await loop.stop();

    expect(executed).toEqual(["cmd_r1", "cmd_r2"]);
    const backoffAnnouncements = warns.filter((w) => w.includes("backing off"));
    expect(backoffAnnouncements).toHaveLength(2);
    for (const w of backoffAnnouncements) expect(w).toContain("backing off 1000ms");
  }, 15_000);
});

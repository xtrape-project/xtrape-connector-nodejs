import { afterEach, describe, expect, it } from "vitest";
import { CeLongPollLoop, CeServiceConnector, serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest, StreamDelivery } from "@xtrape/contracts";

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

const transport = { contractVersion: 1, mode: "LONG_POLL", waitMs: 1_000, maxBatch: 16 } as const;

function commandDelivery(commandId: string, over: Partial<Extract<StreamDelivery, { kind: "COMMAND" }>["command"]> = {}): StreamDelivery {
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
      ...over,
    },
  } as StreamDelivery;
}

/**
 * Fake World A platform-ce over injectable fetch: registration answers with
 * transport parameters; poll answers from a scripted queue (then hangs-ish by
 * returning 204); ack/report/messages are recorded.
 */
function fakeWorldAServer(pollScript: Array<{ status: number; body?: unknown }>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const polls: number[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (u.endsWith("/v1/instances") && method === "POST") {
      return json({ contractVersion: 1, instanceId: (body as { instance: { instanceId: string } }).instance.instanceId, accessToken: "xtr_test_token", transport });
    }
    if (u.includes("/deliveries/poll")) {
      polls.push(Date.now());
      const next = pollScript.shift();
      if (!next) {
        // Script exhausted: model the REAL Platform behavior — hang until the
        // client aborts (loop shutdown), instead of instantly answering.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return next.body !== undefined ? json(next.body, next.status) : new Response(null, { status: next.status });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  const of = (suffix: string) => calls.filter((c) => c.url.includes(suffix));
  return { calls, polls, fetchImpl, of };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("World A registration provisioning (agent-nodejs#44)", () => {
  it("parses Platform-authoritative transport parameters from the registration response", async () => {
    const srv = fakeWorldAServer([]);
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://127.0.0.1:9", fetchImpl: srv.fetchImpl });
    const result = await connector.register();
    expect(result.transport).toEqual(transport);
    expect(connector.transportParameters).toEqual(transport);
  });

  it("rejects a wire-invalid transport block instead of mis-provisioning silently", async () => {
    const bad = (async () =>
      json({ contractVersion: 1, instanceId: "i", accessToken: "t", transport: { contractVersion: 1, mode: "LONG_POLL", waitMs: 10, maxBatch: 0 } })) as unknown as typeof fetch;
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://127.0.0.1:9", fetchImpl: bad });
    await expect(connector.register()).rejects.toThrow();
  });
});

describe("CeLongPollLoop delivery semantics", () => {
  it("dispatches new identities once, re-acks duplicates without re-dispatch, and acks every deliveryId", async () => {
    const first = commandDelivery("cmd_1");
    const redelivered = { ...first, deliveryId: "dlv_cmd_1.2", attempt: 2 } as StreamDelivery;
    const srv = fakeWorldAServer([
      { status: 200, body: { contractVersion: 1, deliveries: [first] } },
      { status: 200, body: { contractVersion: 1, deliveries: [redelivered] } },
    ]);
    const executed: string[] = [];
    const loop = new CeLongPollLoop({
      serverUrl: "http://srv:3000",
      instanceId: "inst-1",
      transport,
      authHeaders: () => ({ "x-xtrape-access-token": "t" }),
      fetchImpl: srv.fetchImpl,
      handlers: {
        onExecute: (c: { commandId: string }) => void executed.push(c.commandId),
        onReview: () => undefined,
        onCancel: () => undefined,
        onMessage: () => undefined,
      },
    });
    void loop.start();
    await until(() => srv.of("/deliveries/ack").length >= 2);
    await loop.stop();

    expect(executed).toEqual(["cmd_1"]); // deduped: executed once despite redelivery
    const acks = srv.of("/deliveries/ack").map((c) => (c.body as { deliveryIds: string[] }).deliveryIds);
    expect(acks[0]).toEqual(["dlv_cmd_1.1"]);
    expect(acks[1]).toEqual(["dlv_cmd_1.2"]); // duplicate still acked
  });

  it("routes a REVIEW delivery to onReview — never to onExecute (runtime-platform/13; onReview is REQUIRED, review 3195)", async () => {
    const reviewed: string[] = [];
    const srvReview = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_r", { operation: "REVIEW" })] } }]);
    const loopReview = new CeLongPollLoop({
      serverUrl: "http://srv:3000",
      instanceId: "inst-1",
      transport,
      authHeaders: () => undefined,
      fetchImpl: srvReview.fetchImpl,
      handlers: {
        onExecute: () => { throw new Error("a REVIEW must never reach onExecute"); },
        onReview: (c: { commandId: string }) => void reviewed.push(c.commandId),
        onCancel: () => undefined,
        onMessage: () => undefined,
      },
    });
    void loopReview.start();
    await until(() => srvReview.of("/deliveries/ack").length >= 1);
    await loopReview.stop();
    expect(reviewed).toEqual(["cmd_r"]);
  });

  it("stops with onFatal on a stale-credential 401 instead of hammering the Platform", async () => {
    const srv = fakeWorldAServer([{ status: 401, body: { code: "UNAUTHORIZED" } }]);
    let fatal: Error | undefined;
    const loop = new CeLongPollLoop({
      serverUrl: "http://srv:3000",
      instanceId: "inst-1",
      transport,
      authHeaders: () => undefined,
      fetchImpl: srv.fetchImpl,
      handlers: { onExecute: () => undefined, onReview: () => undefined, onCancel: () => undefined, onMessage: () => undefined, onFatal: (e: Error) => (fatal = e) },
    });
    await loop.start(); // returns when the loop ends
    expect(fatal?.message).toContain("401");
    expect(srv.polls.length).toBe(1);
  });
});

describe("serveCeService World A runtime", () => {
  it("executes a delivered command and reports COMPLETED; catalog no longer advertises `async`", async () => {
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_ok")] } }]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", async: true, execute: (input) => ({ pong: (input as { probe: number }).probe }) }],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_ok/result").length >= 1);
    const report = srv.of("/commands/cmd_ok/result")[0].body as Record<string, unknown>;
    expect(report).toMatchObject({ status: "COMPLETED", result: { pong: 1 } });

    const actions = await (await fetch(`http://127.0.0.1:${handle.port}/actions`)).json();
    expect(actions[0]).not.toHaveProperty("async"); // uniformly async transport
  });

  it("hands the delivered origin to the action as context, and declares the capability in its manifest (xtrape-docs#256)", async () => {
    const delivered = commandDelivery("cmd_origin", { origin: { account: "part_agent_1", traceId: "tr_1" } } as never);
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [delivered] } }]);
    const seen: unknown[] = [];
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", execute: (_input, ctx) => { seen.push(ctx?.origin); return { ok: true }; } }],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_origin/result").length >= 1);
    // The origin arrives on the context exactly as the Platform delivered it.
    expect(seen).toEqual([{ account: "part_agent_1", traceId: "tr_1" }]);
    // And the registration told the Platform this Worker can take it: the
    // feature bit is what makes the optional wire field safe to send.
    const registration = srv.of("/v1/instances")[0]!.body as { manifest: { features?: Record<string, boolean> } };
    expect(registration.manifest.features?.commandOrigin).toBe(true);
  });

  it("a delivery WITHOUT origin leaves the context origin undefined — the action reads that as `{}`", async () => {
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_noorigin")] } }]);
    const seen: unknown[] = [];
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", execute: (_input, ctx) => { seen.push(ctx?.origin); return { ok: true }; } }],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_noorigin/result").length >= 1);
    expect(seen).toEqual([undefined]);
  });

  it("passes an action's outcome envelope through field-for-field — the SDK never reclassifies (agent#70, server-ce#138)", async () => {
    // Terminal classification belongs to the Platform (server-ce#138): the SDK's
    // duty is to lose nothing on the way there. A controlled failure envelope
    // must reach the report body with every field intact, so the Platform still
    // sees `success:false` and settles the command as FAILED.
    const envelope = { success: false, error: { code: "DEMO_FAILURE", message: "deliberate failure" }, retryable: false, details: { attempt: 2 } };
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_envelope")] } }]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", execute: () => envelope }],
      fetchImpl: srv.fetchImpl,
    });

    await until(() => srv.of("/commands/cmd_envelope/result").length >= 1);
    const report = srv.of("/commands/cmd_envelope/result")[0].body as Record<string, unknown>;
    // No local reclassification: the SDK reports what the handler returned...
    expect(report.status).toBe("COMPLETED");
    // ...and every field of the envelope survives, including retryable/details.
    expect(report.result).toEqual(envelope);
  });

  it("runs a delivered EXECUTE of a two-phase action (the Platform dispatches it only after an ADMITTED review — runtime-platform/13) and answers a REVIEW delivery from prepare() as { next }", async () => {
    let executed = false;
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_two_phase", { actionName: "manageAccounts", input: { reviewBinding: "v1.sealed" } }), commandDelivery("cmd_review", { operation: "REVIEW", actionName: "manageAccounts" })] } }]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{
        name: "manageAccounts",
        label: "Manage accounts",
        inputSchema: { type: "object", properties: { accountId: { type: "string" }, reviewBinding: { type: "string" } }, required: ["reviewBinding"], additionalProperties: false },
        prepare: () => ({ currentState: { accounts: [] }, initialPayload: { reviewBinding: "v1.sealed" } }),
        execute: () => { executed = true; return { ok: true }; },
      }],
      fetchImpl: srv.fetchImpl,
    });

    await until(() => srv.of("/commands/cmd_two_phase/result").length >= 1 && srv.of("/commands/cmd_review/result").length >= 1);
    expect(srv.of("/commands/cmd_two_phase/result")[0].body).toMatchObject({ status: "COMPLETED", result: { ok: true } });
    expect(executed).toBe(true);
    // the review: the 13 §9 alias over prepare — inputSchema falls back to the action's own, the card and the seal ride along; no execute ran for it
    const review = srv.of("/commands/cmd_review/result")[0].body as { status: string; result: { next: Record<string, unknown> } };
    expect(review.status).toBe("COMPLETED");
    expect(review.result.next).toEqual({
      inputSchema: { type: "object", properties: { accountId: { type: "string" }, reviewBinding: { type: "string" } }, required: ["reviewBinding"], additionalProperties: false },
      initialPayload: { reviewBinding: "v1.sealed" },
      currentState: { accounts: [] },
    });
  });

  it("answers a REVIEW delivery with the action's own review handler when it has one, and refuses ACTION_NOT_REVIEWABLE when it has neither review nor prepare", async () => {
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_r1", { operation: "REVIEW", actionName: "withReview" }), commandDelivery("cmd_r2", { operation: "REVIEW", actionName: "plain" })] } }]);
    let executedPlain = false;
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [
        {
          name: "withReview",
          label: "With review",
          review: async (_input, ctx) => ({ inputSchema: { type: "object", properties: {}, additionalProperties: false }, initialPayload: { reviewBinding: `sealed-for-${ctx.commandId}` }, currentState: { title: "card" } }),
          execute: () => ({ ok: true }),
        },
        { name: "plain", label: "Plain", execute: () => { executedPlain = true; return { ok: true }; } },
      ],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_r1/result").length >= 1 && srv.of("/commands/cmd_r2/result").length >= 1);
    expect(srv.of("/commands/cmd_r1/result")[0].body).toMatchObject({ status: "COMPLETED", result: { next: { initialPayload: { reviewBinding: "sealed-for-cmd_r1" }, currentState: { title: "card" } } } });
    expect(srv.of("/commands/cmd_r2/result")[0].body).toMatchObject({ status: "FAILED", failureReason: "ERROR", errorCode: "ACTION_NOT_REVIEWABLE" });
    expect(executedPlain).toBe(false);
  });

  it("re-reports a pre-admission refusal on its own when the first report is lost (review 2203)", async () => {
    // ACTION_NOT_FOUND used to be a one-shot best-effort report. The COMMAND
    // was already acked off the stream, so first-report-fails meant: no
    // unreported state, no retry owner, Platform RUNNING for ever. The
    // refusal now claims the same lifecycle as every terminal outcome.
    const calls: { url: string; body?: unknown }[] = [];
    let resultPosts = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, body });
      if (u.endsWith("/v1/instances") && (init?.method ?? "GET") === "POST") {
        return json({ contractVersion: 1, instanceId: (body as { instance: { instanceId: string } }).instance.instanceId, accessToken: "xtr_test_token", transport });
      }
      if (u.includes("/deliveries/poll")) {
        if (calls.filter((c) => c.url.includes("/deliveries/poll")).length === 1) {
          return json({ contractVersion: 1, deliveries: [commandDelivery("cmd_ghost", { actionName: "no-such-action" })] });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        resultPosts += 1;
        // First report lost in an outage; later ones accepted.
        if (resultPosts === 1) return new Response("boom", { status: 503 });
        return json({ contractVersion: 1, commandId: "cmd_ghost", outcome: "APPLIED" });
      }
      return json({ ok: true });
    }) as unknown as typeof fetch;
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", execute: () => ({ pong: 1 }) }],
      fetchImpl,
    });

    // Nothing redelivers cmd_ghost — the second report can only come from the
    // retry owner picking the refusal up out of `unreported`.
    await until(() => resultPosts >= 2, 15_000);
    const second = calls.filter((c) => /\/commands\/cmd_ghost\/result$/.test(c.url))[1]!.body as Record<string, unknown>;
    expect(second).toMatchObject({ status: "FAILED", errorCode: "ACTION_NOT_FOUND" });
  }, 25_000);

  it("still runs a single-phase action delivered over the same channel", async () => {
    let executed = false;
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_single")] } }]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      actions: [{ name: "ping", label: "Ping", execute: () => { executed = true; return { pong: 1 }; } }],
      fetchImpl: srv.fetchImpl,
    });

    await until(() => srv.of("/commands/cmd_single/result").length >= 1);
    expect(srv.of("/commands/cmd_single/result")[0].body).toMatchObject({ status: "COMPLETED" });
    expect(executed).toBe(true);
  });

  it("does NOT end an action by elapsed time — timeoutSeconds is disclosure, not a client deadline (docs#242)", async () => {
    // The Connector used to start a timer from the delivered timeoutSeconds,
    // abort the action, and report FAILED(TIMEOUT). That is removed: an action
    // may legitimately run for hours (a deploy, a task waiting on a person via
    // ask()), and a Connector-side clock ending it is the exact "terminate
    // business by elapsed time" the platform no longer does.
    const srv = fakeWorldAServer([
      { status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_slow", { timeoutSeconds: 1 })] } },
    ]);
    let sawBudget: number | undefined;
    let release!: () => void;
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: (_input, context) => {
            // The value is still delivered to the action, as disclosure.
            sawBudget = context?.timeoutSeconds;
            return new Promise((resolve) => {
              release = () => resolve("done");
            });
          },
        },
      ],
      fetchImpl: srv.fetchImpl,
    });
    // Well past the delivered 1s "budget": no report, the action still runs.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(srv.of("/commands/cmd_slow/result").length).toBe(0);
    expect(sawBudget).toBe(1); // disclosed to the action, not enforced against it
    // It settles only when the action itself finishes.
    release();
    await until(() => srv.of("/commands/cmd_slow/result").length >= 1, 5_000);
    expect(srv.of("/commands/cmd_slow/result")[0].body).toMatchObject({ status: "COMPLETED" });
  });

  it("a delivered CANCEL aborts the in-flight execution and reports FAILED(CANCELLED)", async () => {
    const cancel: StreamDelivery = {
      kind: "CANCEL",
      deliveryId: "dlv_cnl.1",
      attempt: 1,
      cancellation: { cancelId: "cnl_cmd_run", commandId: "cmd_run", issuedAt: new Date().toISOString(), reason: "operator asked" },
    } as StreamDelivery;
    const srv = fakeWorldAServer([
      { status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_run", { timeoutSeconds: 60 })] } },
      { status: 200, body: { contractVersion: 1, deliveries: [cancel] } },
    ]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: (_input, context) =>
            new Promise((_resolve, reject) => {
              context?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        },
      ],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_run/result").length >= 1, 5_000);
    const report = srv.of("/commands/cmd_run/result")[0].body as Record<string, unknown>;
    expect(report).toMatchObject({ status: "FAILED", failureReason: "CANCELLED" });
  });

  it("a cancel that beat the execute wins over ACTION_NOT_FOUND classification (review 2205)", async () => {
    // Admission must precede classification. The registry had recorded
    // cancelled-before-start; the pre-admission refusal then beginReporting'd
    // right over it, and the Platform was told ACTION_NOT_FOUND about a
    // command it had already cancelled.
    const cancel: StreamDelivery = {
      kind: "CANCEL",
      deliveryId: "dlv_cnl_ghost.1",
      attempt: 1,
      cancellation: { cancelId: "cnl_cmd_ghost2", commandId: "cmd_ghost2", issuedAt: new Date().toISOString(), reason: "stop" },
    } as StreamDelivery;
    const srv = fakeWorldAServer([
      { status: 200, body: { contractVersion: 1, deliveries: [cancel] } },
      { status: 200, body: { contractVersion: 1, deliveries: [commandDelivery("cmd_ghost2", { actionName: "no-such-action" })] } },
    ]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ pong: 1 }) }],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_ghost2/result").length >= 1, 5_000);
    const report = srv.of("/commands/cmd_ghost2/result")[0].body as Record<string, unknown>;
    // The cancel is the truth; the missing action never enters into it.
    expect(report).toMatchObject({ status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED" });
  });

  it("surfaces a fatal poll rejection and stops presenting a healthy runtime", async () => {
    const srv = fakeWorldAServer([{ status: 401, body: { code: "UNAUTHORIZED" } }]);
    let fatal: Error | undefined;
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 20,
      handler: () => "ok",
      fetchImpl: srv.fetchImpl,
      onTransportFatal: (error) => {
        fatal = error;
      },
    });
    await until(() => fatal !== undefined);
    const heartbeatsAtFatal = srv.of("/heartbeat").length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fatal?.message).toContain("401");
    expect(srv.polls.length).toBe(1);
    expect(srv.of("/heartbeat").length).toBe(heartbeatsAtFatal);
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, code: "TRANSPORT_FATAL" });
  });

  it("does not start a second execution when an active command falls out of the bounded delivery LRU", async () => {
    const active = commandDelivery("cmd_active", { timeoutSeconds: 60 });
    const filler = Array.from({ length: 1_024 }, (_, i) => commandDelivery(`cmd_fill_${i}`, { operation: "REVIEW", actionName: "no-such-action" }));
    const batches = Array.from({ length: 64 }, (_, batch) => ({
      status: 200,
      body: { contractVersion: 1, deliveries: filler.slice(batch * transport.maxBatch, (batch + 1) * transport.maxBatch) },
    })).filter((entry) => entry.body.deliveries.length > 0);
    const redelivery = { ...active, deliveryId: "dlv_cmd_active.2", attempt: 2 } as StreamDelivery;
    const cancel: StreamDelivery = {
      kind: "CANCEL",
      deliveryId: "dlv_cnl_active.1",
      attempt: 1,
      cancellation: {
        cancelId: "cnl_cmd_active",
        commandId: "cmd_active",
        issuedAt: new Date().toISOString(),
        reason: "finish test",
      },
    } as StreamDelivery;
    const srv = fakeWorldAServer([
      { status: 200, body: { contractVersion: 1, deliveries: [active] } },
      ...batches,
      { status: 200, body: { contractVersion: 1, deliveries: [redelivery] } },
      { status: 200, body: { contractVersion: 1, deliveries: [cancel] } },
    ]);
    let executions = 0;
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: (_input, context) => {
            executions += 1;
            return new Promise((_resolve, reject) => {
              context?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        },
      ],
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/commands/cmd_active/result").length >= 1, 5_000);
    expect(executions).toBe(1);
    expect(srv.of("/commands/cmd_active/result")[0].body).toMatchObject({ status: "FAILED", failureReason: "CANCELLED" });
  });

  it("handles a routed MESSAGE delivery and posts the reply through the outbound message route", async () => {
    const message: StreamDelivery = {
      kind: "MESSAGE",
      deliveryId: "dlv_msg.1",
      attempt: 1,
      message: {
        contractVersion: 1,
        messageId: "m1",
        conversationId: "conv-1",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:42",
        messageType: "QUERY",
        content: "status?",
      },
    } as StreamDelivery;
    const srv = fakeWorldAServer([{ status: 200, body: { contractVersion: 1, deliveries: [message] } }]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      fetchImpl: srv.fetchImpl,
    });
    await until(() => srv.of("/messages").length >= 1, 5_000);
    const reply = srv.of("/messages")[0].body as Record<string, unknown>;
    expect(reply).toMatchObject({
      conversationId: "conv-1",
      senderType: "SERVICE",
      targetType: "USER",
      targetId: "telegram:42",
      replyToMessageId: "m1",
      content: "echo: status?",
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_FEATURE, reviewFaceFor, serveCeService, type CePrepareContext, type CeReviewContext, type CeReviewResult, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

/**
 * The World B REVIEW door (runtime-platform/13 §9) and its command lifecycle
 * (review 3195): admitted through the same registry as execute, one frozen
 * answer per command id, the §4.3 candidate exchange reachable from the
 * `prepare` alias, and no advertised capability on an unregistered instance.
 */
const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-review-service", name: "Demo Review", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

/** Fake Platform: registration, and a §4.3 exchange that admits only `admits`. */
function fakePlatform(admits: string[]) {
  const registered: Record<string, unknown>[] = [];
  const exchanges: { commandId: string; candidates: string[]; auth?: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/v1/instances")) {
      registered.push(body);
      return json(200, { instanceId: "demo-1", accessToken: "xtrape_at_test" });
    }
    const m = /\/commands\/([^/]+)\/candidate-resources$/.exec(u);
    if (m) {
      const candidates = body.candidates as string[];
      exchanges.push({ commandId: decodeURIComponent(m[1]!), candidates, auth: (init?.headers as Record<string, string>)?.["x-xtrape-access-token"] });
      return json(200, { contractVersion: 1, commandId: body.commandId, admitted: candidates.filter((c) => admits.includes(c)) });
    }
    return json(200, { ok: true });
  }) as unknown as typeof fetch;
  return { fetchImpl, registered, exchanges };
}

const review = (port: number, name: string, commandId?: string, body: unknown = {}) =>
  fetch(`http://127.0.0.1:${port}/actions/${name}/review`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", ...(commandId ? { "x-xtrape-command-id": commandId } : {}) },
    body: JSON.stringify(body),
  });

const cancel = (port: number, commandId: string) =>
  fetch(`http://127.0.0.1:${port}/commands/${commandId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
    body: JSON.stringify({ contractVersion: 1, commandId }),
  });

async function start(fetchImpl: typeof fetch, actions: NonNullable<Parameters<typeof serveCeService>[0]["actions"]>, extra: Partial<Parameters<typeof serveCeService>[0]> = {}) {
  handle = await serveCeService({
    serverUrl: "http://srv:3000",
    manifest,
    host: "127.0.0.1",
    heartbeatMs: 0,
    callbackToken: "tok",
    handler: () => "ok",
    actions,
    fetchImpl,
    ...extra,
  });
  return handle;
}

const KNOWN_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const digestOf = (n: string) => `sha256:${n.repeat(64)}`;
const executionFace = {
  risk: "HIGH" as const,
  resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: digestOf("2"), executionProfileRecord: digestOf("3") },
};
/** A mutating single-phase Checkpoint on the known schema record; callers may add a `review` face. */
function checkpointFixture() {
  return {
    contractVersion: 1 as const,
    id: { serviceId: "demo-review-service", checkpointId: "server.reboot", checkpointVersion: "1.0.0" },
    inputSchema: { schemaRecord: KNOWN_DIGEST }, outputSchema: { schemaRecord: KNOWN_DIGEST },
    resourceExtraction: executionFace.resourceExtraction,
    sideEffect: "MUTATING" as const, risk: "HIGH" as const,
    sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
    idempotency: "NON_IDEMPOTENT" as const, delivery: "AT_MOST_ONCE" as const,
    retry: "NONE" as const, execution: "SYNC" as const, action: { actionId: "reboot" }, localPreconditions: [],
  };
}

describe("World B REVIEW door — lifecycle and exchange (review 3195)", () => {
  it("a direct `review` runs the §4.3 exchange with the lifecycle credential and offers ONLY the admitted subset", async () => {
    const platform = fakePlatform(["srv-a"]);
    let reviews = 0;
    const h = await start(platform.fetchImpl, [
      {
        name: "reboot",
        label: "Reboot",
        review: async (_input: unknown, ctx: CeReviewContext): Promise<CeReviewResult> => {
          reviews += 1;
          const admitted = await ctx.filterResources(["srv-a", "srv-b"]);
          return {
            inputSchema: { type: "object", properties: { server: { type: "string", enum: admitted } }, required: ["server"], additionalProperties: false },
            initialPayload: { server: admitted[0] },
            currentState: { commandId: ctx.commandId },
          };
        },
        execute: () => ({ ok: true }),
      },
    ]);
    const res = await review(h.port, "reboot", "cmd_rv_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next: CeReviewResult };
    expect((body.next.inputSchema as { properties: { server: { enum: string[] } } }).properties.server.enum).toEqual(["srv-a"]);
    expect(body.next.currentState).toEqual({ commandId: "cmd_rv_1" });
    expect(platform.exchanges).toEqual([{ commandId: "cmd_rv_1", candidates: ["srv-a", "srv-b"], auth: "xtrape_at_test" }]);

    // 13 §5.5: a retry of the SAME review command recovers the SAME frozen
    // `next` — the review handler is not run a second time.
    const again = await review(h.port, "reboot", "cmd_rv_1");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    expect(reviews).toBe(1);
    expect(platform.exchanges).toHaveLength(1);
  });

  it("the `prepare` alias reaches the same exchange through CePrepareContext.filterResources — unauthorized candidates never appear", async () => {
    const platform = fakePlatform(["acc-2"]);
    const seen: Array<boolean> = [];
    const h = await start(platform.fetchImpl, [
      {
        name: "reloginAccount",
        label: "Re-login",
        prepare: async (_input: unknown, ctx?: CePrepareContext) => {
          seen.push(typeof ctx?.filterResources === "function");
          const accounts = ctx?.filterResources ? await ctx.filterResources(["acc-1", "acc-2", "acc-3"]) : ["acc-1", "acc-2", "acc-3"];
          return { initialPayload: { accountId: accounts[0] }, currentState: { accounts } };
        },
        execute: () => ({ ok: true }),
      },
    ]);
    const res = await review(h.port, "reloginAccount", "cmd_rv_2");
    expect(res.status).toBe(200);
    expect((await res.json()).next).toMatchObject({ initialPayload: { accountId: "acc-2" }, currentState: { accounts: ["acc-2"] } });
    expect(platform.exchanges[0]).toMatchObject({ commandId: "cmd_rv_2", candidates: ["acc-1", "acc-2", "acc-3"] });

    // The legacy /prepare door carries no exchange seam: the alias is the only
    // place `filterResources` exists.
    const legacy = await fetch(`http://127.0.0.1:${h.port}/actions/reloginAccount/prepare`, { method: "POST", headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" }, body: "{}" });
    expect(legacy.status).toBe(200);
    expect(seen).toEqual([true, false]);
  });

  it("the door is a Command door: without x-xtrape-command-id it is refused and the handler never runs (review 3196)", async () => {
    const platform = fakePlatform([]);
    let reviews = 0;
    const h = await start(platform.fetchImpl, [
      { name: "reboot", label: "Reboot", review: () => { reviews += 1; return { inputSchema: { type: "object", properties: {}, additionalProperties: false }, initialPayload: {}, currentState: {} }; }, prepare: () => ({ currentState: { alias: true } }), execute: () => ({ ok: true }) },
    ]);
    const res = await review(h.port, "reboot");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("COMMAND_ID_REQUIRED");
    expect(reviews).toBe(0);
    // The commandless compatibility surface is still the legacy /prepare door.
    const legacy = await fetch(`http://127.0.0.1:${h.port}/actions/reboot/prepare`, { method: "POST", headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" }, body: "{}" });
    expect(legacy.status).toBe(200);
  });

  it("a CANCEL that arrives while the review handler runs wins: the late result is discarded, the command settles as cancelled (review 3196)", async () => {
    const platform = fakePlatform([]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sawAbort = false;
    const h = await start(platform.fetchImpl, [
      {
        name: "reboot",
        label: "Reboot",
        review: async (_input: unknown, ctx: CeReviewContext) => {
          await gate;
          sawAbort = ctx.signal?.aborted === true;
          return { inputSchema: { type: "object", properties: {}, additionalProperties: false }, initialPayload: {}, currentState: { late: true } };
        },
        execute: () => ({ ok: true }),
      },
    ]);
    const pending = review(h.port, "reboot", "cmd_rv_6");
    await new Promise((r) => setTimeout(r, 50));
    expect(((await (await cancel(h.port, "cmd_rv_6")).json()) as { outcome: string }).outcome).toBe("CANCELLING");
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CANCELLED");
    expect(sawAbort).toBe(true);
    // Nothing frozen: a retry finds the cancelled tombstone, never the late card.
    const retry = await review(h.port, "reboot", "cmd_rv_6");
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("COMMAND_IN_FLIGHT");
    expect(((await (await cancel(h.port, "cmd_rv_6")).json()) as { outcome: string; status: string })).toMatchObject({ outcome: "ALREADY_TERMINAL", status: "FAILED" });
  });

  it("a CANCEL that arrived first wins: the review is refused 409 CANCELLED and never runs", async () => {
    const platform = fakePlatform([]);
    let reviews = 0;
    const h = await start(platform.fetchImpl, [
      { name: "reboot", label: "Reboot", review: () => { reviews += 1; return { inputSchema: { type: "object", properties: {}, additionalProperties: false }, initialPayload: {}, currentState: {} }; }, execute: () => ({ ok: true }) },
    ]);
    expect(((await (await cancel(h.port, "cmd_rv_3")).json()) as { outcome: string }).outcome).toBe("CANCELLING");
    const res = await review(h.port, "reboot", "cmd_rv_3");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CANCELLED");
    expect(reviews).toBe(0);
  });

  it("a failed review settles the command — the same id is not re-run and a review-less action is a clean 400", async () => {
    const platform = fakePlatform([]);
    const h = await start(platform.fetchImpl, [
      { name: "broken", label: "Broken", review: () => { throw new Error("boom"); }, execute: () => ({ ok: true }) },
      { name: "plain", label: "Plain", execute: () => ({ ok: true }) },
    ]);
    expect((await review(h.port, "broken", "cmd_rv_4")).status).toBe(500);
    const replay = await review(h.port, "broken", "cmd_rv_4");
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe("COMMAND_IN_FLIGHT");
    const none = await review(h.port, "plain", "cmd_rv_5");
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe("ACTION_NOT_REVIEWABLE");
  });

  it("the legacy catalog marks a review-only action requiresPrepare (an older Platform must not dispatch it single-phase)", async () => {
    const platform = fakePlatform([]);
    const h = await start(platform.fetchImpl, [
      { name: "reboot", label: "Reboot", review: () => ({ inputSchema: { type: "object", properties: {}, additionalProperties: false }, initialPayload: {}, currentState: {} }), execute: () => ({ ok: true }) },
      { name: "plain", label: "Plain", execute: () => ({ ok: true }) },
    ]);
    const list = (await (await fetch(`${h.address}/actions`, { headers: { "x-xtrape-service-callback-token": "tok" } })).json()) as Array<{ name: string; requiresPrepare?: boolean }>;
    expect(list.find((a) => a.name === "reboot")?.requiresPrepare).toBe(true);
    expect(list.find((a) => a.name === "plain")?.requiresPrepare).toBeUndefined();
  });

  it("advertises REVIEW_FEATURE only on a registered instance — listen-only has no credential for the exchange", async () => {
    const platform = fakePlatform([]);
    await start(platform.fetchImpl, [{ name: "plain", label: "Plain", execute: () => ({ ok: true }) }]);
    expect(((platform.registered[0]!.manifest as { features: Record<string, boolean> }).features)[REVIEW_FEATURE]).toBe(true);
    await handle!.close();
    handle = undefined;

    // World B: the authenticated descriptor is the only place the manifest
    // leaves a listen-only instance (it needs at least one Checkpoint).
    const checkpoint = checkpointFixture();
    const h = await serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true, callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest: KNOWN_DIGEST }],
      checkpoints: [checkpoint],
      actions: [{ name: "reboot", label: "Reboot", checkpoint: checkpoint.id, execute: () => ({ ok: true }) }],
    });
    handle = h;
    const response = await fetch(`${h.address}/descriptor`, { headers: { authorization: "Bearer wb-issued" } });
    expect(response.status).toBe(200);
    const descriptor = (await response.json()) as { manifest: { features?: Record<string, boolean> } };
    expect(descriptor.manifest.features?.[REVIEW_FEATURE]).toBeUndefined();
  });
});

describe("review-face authoring (runtime-platform/13 §4.2)", () => {
  it("reviewFaceFor defaults risk to the execution risk, resource to the execution extraction, affinity to INCARNATION", () => {
    expect(reviewFaceFor(executionFace, { inputSchema: { schemaRecord: digestOf("a") }, outputSchema: { schemaRecord: digestOf("b") } })).toEqual({
      inputSchema: { schemaRecord: digestOf("a") },
      outputSchema: { schemaRecord: digestOf("b") },
      resource: executionFace.resourceExtraction,
      risk: "HIGH",
      affinity: "INCARNATION",
    });
    expect(reviewFaceFor(executionFace, { inputSchema: { schemaRecord: digestOf("a") }, outputSchema: { schemaRecord: digestOf("b") }, risk: "LOW", affinity: "NONE" })).toMatchObject({ risk: "LOW", affinity: "NONE" });
    // 13 v0.5 §4.3: the candidate parameter rides the face only when declared (absence = no exchange).
    expect(reviewFaceFor(executionFace, { inputSchema: { schemaRecord: digestOf("a") }, outputSchema: { schemaRecord: digestOf("b") }, candidateParameter: "serverId" }).candidateParameter).toBe("serverId");
    expect("candidateParameter" in reviewFaceFor(executionFace, { inputSchema: { schemaRecord: digestOf("a") }, outputSchema: { schemaRecord: digestOf("b") } })).toBe(false);
  });

  it("preflight refuses a review face that cites a schema record absent from the descriptor", async () => {
    const checkpoint = {
      ...checkpointFixture(),
      review: reviewFaceFor(executionFace, { inputSchema: { schemaRecord: KNOWN_DIGEST }, outputSchema: { schemaRecord: digestOf("f") } }),
    };
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true, callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
        schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest: KNOWN_DIGEST }],
        checkpoints: [checkpoint],
        actions: [{ name: "reboot", label: "Reboot", checkpoint: checkpoint.id, execute: () => ({ ok: true }) }],
      }),
    ).rejects.toThrow(/review\.outputSchema references schema record/);
  });
});

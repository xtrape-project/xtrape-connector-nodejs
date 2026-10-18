import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

/**
 * World B / listen-only mode (canonical runtime-platform/09 §4): the service
 * only deploys — it issues its own token, exposes the HTTP surface, and never
 * dials the Platform. The operator records address + token in platform-ce.
 */

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "wb-demo", name: "WB Demo", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

let handle: ServeCeServiceHandle | undefined;

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("listen-only mode (World B, docs/09 §4)", () => {
  it("never dials the Platform: no register, no heartbeat, no poll", async () => {
    const outbound = vi.fn(async () => new Response("{}", { status: 200 }));
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      listenOnly: true,
      callbackToken: "wb-issued",
      fetchImpl: outbound as unknown as typeof fetch,
      port: 0,
      host: "127.0.0.1",
    });
    // Give any wrongly-started background loop a beat to betray itself.
    await new Promise((r) => setTimeout(r, 150));
    expect(outbound).not.toHaveBeenCalled();
    const descriptor = await fetch(`${handle.address}/descriptor`, { headers: { authorization: "Bearer wb-issued" } });
    expect(descriptor.status).toBe(404);
    expect(await descriptor.json()).toMatchObject({ code: "AUTHORITY_DESCRIPTOR_NOT_AVAILABLE" });
  });

  it("serves one authenticated descriptor snapshot with manifest, Actions, schemas and Checkpoints", async () => {
    const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
      callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint],
      actions: [{ name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, execute: () => ({ ok: true }) }],
    });

    expect((await fetch(`${handle.address}/descriptor`)).status).toBe(401);
    const response = await fetch(`${handle.address}/descriptor`, { headers: { authorization: "Bearer wb-issued" } });
    expect(response.status).toBe(200);
    const descriptor = await response.json() as any;
    expect(descriptor.manifest.service.id).toBe("wb-demo");
    expect(descriptor.actions[0].checkpoint).toEqual(checkpoint.id);
    expect(descriptor.schemaRecords[0].digest).toBe(digest);
    expect(descriptor.checkpoints[0].id).toEqual(checkpoint.id);
  });

  it("freezes governed metadata at startup even when the caller mutates its objects", async () => {
    const digest = "sha256:51da7ceec6376f5f1caac4b422cfa832718adde8bb2de8fda7940d2aff2b043f";
    const inputSchema: Record<string, unknown> = { type: "object", additionalProperties: false };
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    const action = { name: "getRepository", label: "Get repository", inputSchema, checkpoint: checkpoint.id, execute: () => ({ ok: true }) };
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
      callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: JSON.stringify(inputSchema), dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint], actions: [action],
    });
    action.name = "mutated";
    inputSchema.type = "string";
    checkpoint.id.checkpointId = "mutated";

    const response = await fetch(`${handle.address}/descriptor`, { headers: { authorization: "Bearer wb-issued" } });
    const descriptor = await response.json() as any;
    expect(descriptor.actions[0]).toMatchObject({ name: "getRepository", inputSchema: { type: "object" } });
    expect(descriptor.actions[0].checkpoint.checkpointId).toBe("repository.get");
    expect(descriptor.checkpoints[0].id.checkpointId).toBe("repository.get");
    expect((await fetch(`${handle.address}/actions/mutated/execute`, { method: "POST", headers: { authorization: "Bearer wb-issued", "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("publishes one World A authority descriptor and deregisters when admission fails", async () => {
    const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const outbound = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      if (String(url).endsWith("/v1/instances") && init?.method === "POST") {
        return new Response(JSON.stringify({ accessToken: "worker-access" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith("/authority-descriptor")) return new Response(JSON.stringify({ code: "CONFLICT" }), { status: 409, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", fetchImpl: outbound as unknown as typeof fetch,
      instanceId: "worker-1", heartbeatMs: 0, port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint], actions: [{ name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, execute: () => ({ ok: true }) }],
    })).rejects.toThrow();
    expect(calls.filter((call) => call.url.endsWith("/authority-descriptor"))).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/schema-records"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/checkpoints"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/v1/instances/worker-1") && call.method === "DELETE")).toBe(true);
  });

  it("keeps World A operations closed until registration and governed admission both succeed", async () => {
    const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    const registration = deferred<Response>();
    const registrationStarted = deferred<void>();
    const admission = deferred<Response>();
    const admissionStarted = deferred<void>();
    const outbound = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/v1/instances") && init?.method === "POST") {
        registrationStarted.resolve();
        return registration.promise;
      }
      if (String(url).endsWith("/authority-descriptor")) {
        admissionStarted.resolve();
        return admission.promise;
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const execute = vi.fn(() => ({ ok: true }));
    const prepare = vi.fn(() => ({ initialPayload: {} }));
    const messageHandler = vi.fn(() => "ok");
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;
    const starting = serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: messageHandler, fetchImpl: outbound as unknown as typeof fetch,
      instanceId: "worker-ready", heartbeatMs: 0, port, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint], actions: [{ name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, prepare, execute }],
    });

    await registrationStarted.promise;
    const beforeCatalog = await fetch(`${base}/actions`);
    expect(beforeCatalog.status).toBe(503);
    const beforeMessage = await fetch(`${base}/messages`, { method: "POST", body: "{}" });
    expect(beforeMessage.status).toBe(503);
    const beforePrepare = await fetch(`${base}/actions/getRepository/prepare`, { method: "POST", body: "{}" });
    expect(beforePrepare.status).toBe(503);
    const beforeRegistration = await fetch(`${base}/actions/getRepository/execute`, { method: "POST", body: "{}" });
    expect(beforeRegistration.status).toBe(503);
    expect(await beforeRegistration.json()).toMatchObject({ code: "NOT_READY", retryable: true });
    expect(messageHandler).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    registration.resolve(new Response(JSON.stringify({ accessToken: "worker-access", callbackToken: "platform-callback" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await admissionStarted.promise;
    const beforeAdmission = await fetch(`${base}/actions/getRepository/execute`, {
      method: "POST",
      headers: { authorization: "Bearer platform-callback", "content-type": "application/json" },
      body: "{}",
    });
    expect(beforeAdmission.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();

    admission.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    handle = await starting;
    const ready = await fetch(`${base}/actions/getRepository/execute`, {
      method: "POST",
      headers: { authorization: "Bearer platform-callback", "content-type": "application/json" },
      body: "{}",
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never opens World A operations and closes the listener when governed admission fails", async () => {
    const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    const admission = deferred<Response>();
    const admissionStarted = deferred<void>();
    const outbound = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/v1/instances") && init?.method === "POST") {
        return new Response(JSON.stringify({ accessToken: "worker-access", callbackToken: "platform-callback" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/authority-descriptor")) {
        admissionStarted.resolve();
        return admission.promise;
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const execute = vi.fn(() => ({ ok: true }));
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;
    const starting = serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", fetchImpl: outbound as unknown as typeof fetch,
      instanceId: "worker-failed", heartbeatMs: 0, port, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint], actions: [{ name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, execute }],
    });

    await admissionStarted.promise;
    const blocked = await fetch(`${base}/actions/getRepository/execute`, {
      method: "POST", headers: { authorization: "Bearer platform-callback" }, body: "{}",
    });
    expect(blocked.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();

    admission.resolve(new Response(JSON.stringify({ code: "CONFLICT" }), {
      status: 409, headers: { "content-type": "application/json" },
    }));
    await expect(starting).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it("fails closed when a published Checkpoint is not bound one-to-one to an Action", async () => {
    const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const, action: { actionId: "getRepository" }, localPreconditions: [],
    };
    await expect(serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
      callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint], actions: [],
    })).rejects.toThrow(/not bound by an Action/);
  });

  it("refuses a wildcard bind without an explicit routable address", async () => {
    // 0.0.0.0 is where we LISTEN, not where the PLATFORM DIALS (review #71):
    // deriving an address from it would hand the operator a value platform-ce
    // records verbatim and can never reach.
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000",
        manifest,
        handler: () => "ok",
        listenOnly: true,
        callbackToken: "wb-issued",
        port: 0,
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/explicit address/);

    // …and stating the routable address is exactly what unblocks it.
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      listenOnly: true,
      callbackToken: "wb-issued",
      port: 0,
      host: "0.0.0.0",
      address: "http://wb-demo.internal:9090",
    });
    expect(handle.address).toBe("http://wb-demo.internal:9090");
  });

  it("refuses to start without the service-issued token", async () => {
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000",
        manifest,
        handler: () => "ok",
        listenOnly: true,
        port: 0,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(/callbackToken/);
  });

  it("serves messages and actions to callers presenting the token, and only them", async () => {
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: (msg) => `wb: ${msg.content}`,
      actions: [{ name: "echo", label: "Echo", execute: (input) => ({ echoed: input }) }],
      listenOnly: true,
      callbackToken: "wb-issued",
      port: 0,
      host: "127.0.0.1",
    });

    const message = JSON.stringify({
      contractVersion: 1,
      messageId: "m1",
      conversationId: "c1",
      targetType: "SERVICE",
      targetId: "wb-demo",
      senderType: "USER",
      senderId: "u1",
      messageType: "QUERY",
      content: "hello",
    });
    const unauthorized = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: message,
    });
    expect(unauthorized.status).toBe(401);

    const reply = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "wb-issued" },
      body: message,
    });
    expect(reply.status).toBe(200);
    expect(((await reply.json()) as { content: string }).content).toBe("wb: hello");
  });

  it("answers execute synchronously even when the dialer sends a command id", async () => {
    // The 202+report path needs registration credentials a listen-only service
    // does not have; taking it would strand the command RUNNING forever.
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      actions: [{ name: "slowish", label: "S", async: true, execute: () => ({ done: true }) }],
      listenOnly: true,
      callbackToken: "wb-issued",
      port: 0,
      host: "127.0.0.1",
    });
    const res = await fetch(`${handle.address}/actions/slowish/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xtrape-service-callback-token": "wb-issued",
        "x-xtrape-command-id": "cmd_1",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
  });
});

describe("the Checkpoint\u2194Action edge is validated BEFORE publication (contracts 0.8.13, docs#228 D1)", () => {
  const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"; // sha256("{}")
  const definition = (actionId: string) => ({
    contractVersion: 1 as const,
    id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
    inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
    resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
    sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
    sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
    idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
    retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const,
    action: { actionId },
    localPreconditions: [],
  });
  const opts = (actionId: string) => ({
    serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true as const,
    callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
    schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
    checkpoints: [definition(actionId)],
    actions: [{ name: "getRepository", label: "Get repository", checkpoint: definition(actionId).id, execute: () => ({ ok: true }) }],
  });

  it("a definition WITHOUT the edge cannot even be expressed (0.8.13 strict parse)", async () => {
    const { action: _a, ...noEdge } = definition("getRepository");
    await expect(
      serveCeService({ ...opts("getRepository"), checkpoints: [noEdge as never] }),
    ).rejects.toThrow(/must name the one Action/);
  });

  it("a disagreeing edge fails BEFORE publishing — the same refusal the Platform's admission gives (rule 4)", async () => {
    await expect(serveCeService(opts("somethingElse"))).rejects.toThrow(/the two ends of the edge disagree/);
  });
});

describe("live catalog vs D5: a removed governed Action FLOWS THROUGH; only consistency breaks keep the last view (review 2664)", () => {
  const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"; // sha256("{}")
  const checkpoint = {
    contractVersion: 1 as const,
    id: { serviceId: "wb-demo", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
    inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
    resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
    sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
    sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
    idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
    retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const,
    action: { actionId: "getRepository" },
    localPreconditions: [],
  };

  it("removal is visible to the Platform (the Checkpoint may go UNDISPATCHABLE); a disagreeing live edge keeps the last valid view", async () => {
    const live: NonNullable<Parameters<typeof serveCeService>[0]["actions"]> = [
      { name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, execute: () => ({ ok: true }) },
    ];
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
      callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [checkpoint],
      actions: live,
    });
    const names = async () => {
      const res = await fetch(`${handle!.address}/actions`, { headers: { authorization: "Bearer wb-issued" } });
      return ((await res.json()) as Array<{ name: string }>).map((a) => a.name);
    };
    expect(await names()).toEqual(["getRepository"]);

    // D5: the Action legitimately DISAPPEARS. The live read must say so —
    // masking it behind the last snapshot would keep the Platform dispatching
    // an Action the Service no longer offers, and the Checkpoint would never
    // resolve UNDISPATCHABLE(ACTION_MISSING).
    live.splice(0, 1);
    expect(await names()).toEqual([]);

    // ...and a return of the exact reference restores dispatchability.
    live.push({ name: "getRepository", label: "Get repository", checkpoint: checkpoint.id, execute: () => ({ ok: true }) });
    expect(await names()).toEqual(["getRepository"]);

    // A CONSISTENCY break (an action binding the checkpoint under the WRONG
    // name — the two ends of the edge disagree) is a broken catalog, not a
    // smaller one: the last valid view stays published.
    live.splice(0, 1, { name: "renamedWrong", label: "Wrong", checkpoint: checkpoint.id, execute: () => ({ ok: true }) });
    expect(await names()).toEqual(["getRepository"]);
  });
});

describe("online Checkpoint growth is World A only (connector-nodejs#98)", () => {
  it("a listen-only (World B) handle refuses growth — its descriptor is an operator-provisioned atomic snapshot", async () => {
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
      callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
    });
    await expect(handle.publishCheckpoints([])).rejects.toThrow(/re-provision/);
  });
});

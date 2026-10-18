import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as NetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

/** Fake platform-ce: record register/heartbeat calls, always 200. */
function fakePlatformCe() {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function occupyPort(port: number): Promise<NetServer> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return server;
}

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("serveCeService", () => {
  it("registers (with token) and serves /messages + /health", async () => {
    const { calls, fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      registrationToken: "sek",
      heartbeatMs: 0, // no background timer in the test
      handler: (m) => `echo: ${m.content}`,
      fetchImpl,
    });

    // registered against platform-ce with the token
    const register = calls.find((c) => c.url.endsWith("/v1/instances"));
    expect(register?.method).toBe("POST");
    expect(register?.headers?.["x-xtrape-registration-token"]).toBe("sek");
    expect((register?.body?.instance as Record<string, unknown>)?.address).toBe(handle.address);

    // canonical handle key + deprecated alias point at the same instance (connector-nodejs#79)
    expect(handle.connector).toBe(handle.agent);

    // health endpoint
    const health = await fetch(`${handle.address}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "demo-echo-service" });

    // routes an inbound QUERY to the handler and returns a valid reply envelope
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        messageId: "msg_1",
        conversationId: "c1",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:7",
        messageType: "QUERY",
        content: "ping",
      }),
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Record<string, unknown>;
    expect(reply.senderType).toBe("SERVICE");
    expect(reply.senderId).toBe("demo-echo-service");
    expect(reply.targetId).toBe("telegram:7");
    expect(reply.replyToMessageId).toBe("msg_1");
    expect(reply.content).toBe("echo: ping");
  });

  it("returns a structured 400 on an invalid inbound message", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "x",
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: 1, messageId: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_FAILED");
  });

  it("returns a structured 500 when the service handler throws", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => {
        throw new Error("handler exploded");
      },
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        messageId: "msg_2",
        conversationId: "c2",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:9",
        messageType: "QUERY",
        content: "boom",
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "HANDLER_FAILED", message: "handler exploded", retryable: true });
  });

  it("returns a structured 500 when the service handler throws a SyntaxError", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => {
        throw new SyntaxError("handler parse failed");
      },
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        messageId: "msg_2b",
        conversationId: "c2b",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:9",
        messageType: "QUERY",
        content: "boom",
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "HANDLER_FAILED", message: "handler parse failed", retryable: true });
  });

  it("returns a structured 500 when the service builds an invalid reply envelope", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => ({ content: "bad", messageType: "BOGUS" as never }),
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        messageId: "msg_3",
        conversationId: "c3",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:10",
        messageType: "QUERY",
        content: "bad-reply",
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "HANDLER_FAILED", retryable: true });
  });

  it("uses an explicit advertised address for deployed/containerized use", async () => {
    const { calls, fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      address: "http://demo-service:8080",
      heartbeatMs: 0,
      handler: () => "ok",
      fetchImpl,
    });

    const register = calls.find((c) => c.url.endsWith("/v1/instances"));
    expect((register?.body?.instance as Record<string, unknown>)?.address).toBe("http://demo-service:8080");
    expect(handle.address).toBe("http://demo-service:8080");
  });

  it("lists and executes CE service actions", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [
        {
          name: "demoEcho",
          label: "Demo Echo",
          description: "Echo a payload",
          execute: (input) => ({ ok: true, input }),
        },
      ],
      fetchImpl,
    });
    const list = await fetch(`${handle.address}/actions`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([expect.objectContaining({ name: "demoEcho", label: "Demo Echo" })]);
    const exec = await fetch(`${handle.address}/actions/demoEcho/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toEqual({ ok: true, input: { message: "hello" } });
  });

  it("the action list is LIVE: an entry added to the caller's array after start is served on GET /actions and executable; an invalid change keeps the last valid catalog", async () => {
    const { fetchImpl } = fakePlatformCe();
    const live: NonNullable<Parameters<typeof serveCeService>[0]["actions"]> = [
      { name: "alpha", label: "Alpha", execute: () => ({ ran: "alpha" }) },
    ];
    handle = await serveCeService({ serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok", actions: live, fetchImpl });
    const names = async () => ((await (await fetch(`${handle!.address}/actions`)).json()) as Array<{ name: string }>).map((a) => a.name);
    expect(await names()).toEqual(["alpha"]);
    // A governed content version applied by a poll rebuilds the ops entries
    // IN PLACE (linux-ops-widget): no re-registration, no restart.
    live.push({ name: "beta", label: "Beta", execute: () => ({ ran: "beta" }) });
    expect(await names()).toEqual(["alpha", "beta"]);
    const exec = await fetch(`${handle.address}/actions/beta/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await exec.json()).toEqual({ ran: "beta" });
    // A change that breaks the invariants (duplicate name) is refused: the
    // last valid view stays published, nothing half-applied.
    live.push({ name: "beta", label: "Beta again", execute: () => ({ ran: "dup" }) });
    expect(await names()).toEqual(["alpha", "beta"]);
    live.pop();
    live.splice(0, 1); // alpha withdrawn
    expect(await names()).toEqual(["beta"]);
    expect((await fetch(`${handle.address}/actions/alpha/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("World B: the origin rides the Platform-set header, never the body (xtrape-docs#256)", async () => {
    const { fetchImpl } = fakePlatformCe();
    const seen: unknown[] = [];
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [{ name: "who", label: "Who", execute: (_input, ctx) => { seen.push(ctx?.origin); return { ok: true }; } }],
      fetchImpl,
    });
    // Header present and well-formed -> arrives on the context.
    await fetch(`${handle.address}/actions/who/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-command-origin": JSON.stringify({ account: "part_owner", traceId: "tr_b" }) },
      body: JSON.stringify({}),
    });
    // Header malformed -> absent (`{}` for the action), never an error.
    await fetch(`${handle.address}/actions/who/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-command-origin": "{\"kind\":\"human\"}" },
      body: JSON.stringify({}),
    });
    // A caller trying to smuggle an origin through the BODY: not an origin.
    await fetch(`${handle.address}/actions/who/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: { account: "part_owner" } }),
    });
    expect(seen).toEqual([{ account: "part_owner", traceId: "tr_b" }, undefined, undefined]);
  });

  it("World B: PREPARE receives the same origin on its context — valid header, no header, malformed header (review 2458)", async () => {
    const { fetchImpl } = fakePlatformCe();
    const seen: unknown[] = [];
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [{
        name: "card",
        label: "Card",
        prepare: (_input, ctx) => { seen.push(ctx?.origin); return { currentState: {} }; },
        execute: () => ({ ok: true }),
      }],
      fetchImpl,
    });
    const dial = (headers: Record<string, string>, body: unknown = {}) =>
      fetch(`${handle!.address}/actions/card/prepare`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await dial({ "x-xtrape-command-origin": JSON.stringify({ account: "part_owner", traceId: "tr_p" }) })).status).toBe(200);
    expect((await dial({})).status).toBe(200);
    expect((await dial({ "x-xtrape-command-origin": "{\"accountKind\":\"USER\",\"account\":\"part_owner\"}" })).status).toBe(200);
    // A body-smuggled origin is not an origin on prepare either.
    expect((await dial({}, { origin: { account: "part_owner" } })).status).toBe(200);
    expect(seen).toEqual([{ account: "part_owner", traceId: "tr_p" }, undefined, undefined, undefined]);
  });

  it("advertises requiresPrepare and serves a two-phase action's prepare step", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      actions: [
        {
          name: "reloginAccount",
          label: "Re-login account",
          prepare: (input) => ({
            initialPayload: { accountId: "acc-1" },
            currentState: { accounts: ["acc-1", "acc-2"], echoed: input },
          }),
          execute: (input) => ({ ok: true, input }),
        },
        { name: "plain", label: "Plain", execute: () => ({ ok: true }) },
      ],
      fetchImpl,
    });
    const list = await (await fetch(`${handle.address}/actions`)).json();
    expect(list).toContainEqual(expect.objectContaining({ name: "reloginAccount", requiresPrepare: true }));
    // Single-phase actions must not advertise requiresPrepare.
    expect(list.find((a: { name: string }) => a.name === "plain").requiresPrepare).toBeUndefined();

    const prepare = await fetch(`${handle.address}/actions/reloginAccount/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hint: "x" }),
    });
    expect(prepare.status).toBe(200);
    expect(await prepare.json()).toEqual({
      initialPayload: { accountId: "acc-1" },
      currentState: { accounts: ["acc-1", "acc-2"], echoed: { hint: "x" } },
    });

    // Preparing an action that declares no prepare step is a clean 400.
    const notPreparable = await fetch(`${handle.address}/actions/plain/prepare`, { method: "POST" });
    expect(notPreparable.status).toBe(400);
    expect((await notPreparable.json()).code).toBe("ACTION_NOT_PREPARABLE");
  });

  it("rejects startup without an explicit address outside local-only hosts", async () => {
    const { fetchImpl } = fakePlatformCe();
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000",
        manifest,
        heartbeatMs: 0,
        handler: () => "ok",
        fetchImpl,
      }),
    ).rejects.toThrow(/requires an explicit address/);
  });

  it("closes the listener when register fails", async () => {
    const port = await findFreePort();
    const fetchImpl = (async () => {
      throw new Error("register failed");
    }) as unknown as typeof fetch;

    await expect(
      serveCeService({
        serverUrl: "http://srv:3000",
        manifest,
        host: "127.0.0.1",
        address: `http://127.0.0.1:${port}`,
        port,
        heartbeatMs: 0,
        handler: () => "ok",
        fetchImpl,
      }),
    ).rejects.toThrow("register failed");

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("rejects cleanly when the listen port is already in use", async () => {
    const port = await findFreePort();
    const blocker = await occupyPort(port);
    const { fetchImpl } = fakePlatformCe();
    try {
      await expect(
        serveCeService({
          serverUrl: "http://srv:3000",
          manifest,
          host: "127.0.0.1",
          port,
          heartbeatMs: 0,
          handler: () => "ok",
          fetchImpl,
        }),
      ).rejects.toThrow(/EADDRINUSE|address already in use/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("async actions (server-ce#41 Stage B)", () => {
  /** Fake platform-ce that mints an access token on register and records result reports. */
  function fakePlatformCeWithToken() {
    const calls: { url: string; method?: string; headers?: Record<string, string>; body?: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const entry = {
        url: String(url),
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(entry);
      const body = entry.url.endsWith("/v1/instances") ? { instanceId: "i", accessToken: "at-123" } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  async function startAsyncService(execute: (input: unknown) => unknown | Promise<unknown>) {
    const fake = fakePlatformCeWithToken();
    handle = await serveCeService({
      serverUrl: "http://platform-ce.test",
      manifest,
      handler: () => "ok",
      actions: [
        { name: "slowLogin", label: "Slow Login", async: true, execute },
        { name: "quick", label: "Quick", execute: () => ({ fast: true }) },
      ],
      heartbeatMs: 0,
      host: "127.0.0.1",
      fetchImpl: fake.fetchImpl,
    });
    return { fake, base: handle.address };
  }

  async function waitForResultReport(fake: { calls: { url: string }[] }, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = fake.calls.find((c) => c.url.includes("/commands/") && c.url.endsWith("/result"));
      if (call) return call as { url: string; headers?: Record<string, string>; body?: Record<string, unknown> };
      if (Date.now() > deadline) throw new Error("result report not observed in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("no longer advertises the per-action async flag (uniformly async transport, agent-nodejs#44)", async () => {
    const { base } = await startAsyncService(() => ({}));
    const res = await fetch(`${base}/actions`);
    const list = (await res.json()) as Array<{ name: string; async?: boolean }>;
    // The flag was never contracted (docs/09 §6), and it no longer selects
    // anything: the 202 path is taken by every registered push that carries a
    // commandId, flag or no flag. It is ignored entirely — and not a catalog
    // fact.
    expect(list.find((a) => a.name === "slowLogin")?.async).toBeUndefined();
    expect(list.find((a) => a.name === "quick")?.async).toBeUndefined();
  });

  it("acks 202 RUNNING and later reports COMPLETED with the access token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fake, base } = await startAsyncService(async (input) => {
      await gate;
      return { reloggedIn: (input as { accountId: string }).accountId };
    });

    const res = await fetch(`${base}/actions/slowLogin/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-command-id": "cmd_async1" },
      body: JSON.stringify({ accountId: "acc-1" }),
    });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { status: string; commandId: string };
    expect(ack).toMatchObject({ status: "RUNNING", commandId: "cmd_async1" });
    // No result reported yet — the action is still running.
    expect(fake.calls.some((c) => c.url.endsWith("/result"))).toBe(false);

    release();
    const report = await waitForResultReport(fake);
    expect(report.url).toContain("/v1/instances/");
    expect(report.url).toContain("/commands/cmd_async1/result");
    expect(report.headers?.["x-xtrape-access-token"]).toBe("at-123");
    expect(report.body).toMatchObject({ status: "COMPLETED", commandId: "cmd_async1", result: { reloggedIn: "acc-1" } });
  });

  it("reports FAILED with error details when the async handler throws", async () => {
    const { fake, base } = await startAsyncService(() => {
      throw new Error("otp timeout");
    });
    const res = await fetch(`${base}/actions/slowLogin/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-command-id": "cmd_async2" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    const report = await waitForResultReport(fake);
    expect(report.body).toMatchObject({ status: "FAILED", commandId: "cmd_async2", errorCode: "ACTION_FAILED", errorMessage: "otp timeout" });
  });

  it("falls back to synchronous execution when no command id header is sent", async () => {
    const { fake, base } = await startAsyncService(() => ({ done: true }));
    const res = await fetch(`${base}/actions/slowLogin/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(fake.calls.some((c) => c.url.endsWith("/result"))).toBe(false);
  });
});

describe("legacy push hands the action its execution context (review 2175)", () => {
  const manifestLocal = {
    contractVersion: 1,
    tenant: "default",
    service: { id: "demo-echo-service", name: "Demo", version: "0.1.0" },
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  } as const;

  it("passes commandId to a synchronous action when the push carried one", async () => {
    // The header was read and then dropped on the floor, so dedupe and cancel
    // were a World A privilege rather than a transport-independent invariant.
    let seen: { commandId?: string } | undefined;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestLocal as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      listenOnly: true,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: (_input, context) => {
            seen = context;
            return { ok: true };
          },
        },
      ],
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xtrape-service-callback-token": "tok",
          "x-xtrape-command-id": "cmd_push_1",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(seen?.commandId).toBe("cmd_push_1");
    } finally {
      await handle.close();
    }
  });
});

describe("World B settles asynchronously and honours cancel (review 2178)", () => {
  const manifestB = {
    contractVersion: 1,
    tenant: "default",
    service: { id: "demo-echo-service", name: "Demo", version: "0.1.0" },
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  } as const;

  /** A registered service whose server accepts registration and result reports. */
  async function registered(execute: (input: unknown, ctx?: { signal?: AbortSignal; commandId?: string }) => unknown) {
    const reports: { commandId: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const m = /\/commands\/([^/]+)\/result$/.exec(u);
      if (m) reports.push({ commandId: m[1]!, body });
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestB as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute }],
      fetchImpl,
    });
    return { handle, reports };
  }

  const push = (port: number, commandId: string) =>
    fetch(`http://127.0.0.1:${port}/actions/ping/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": commandId },
      body: JSON.stringify({}),
    });

  it("acks RUNNING immediately for an ordinary action, without async: true", async () => {
    // Before: only `async: true` took this path, so an ordinary action that
    // outlived the Platform's forward window wrote its result to an abandoned
    // HTTP response and the command stayed RUNNING for ever.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { handle, reports } = await registered(async () => {
      await gate;
      return { ok: true };
    });
    try {
      const res = await push(handle.port, "cmd_slow_b");
      expect(res.status).toBe(202);
      expect((await res.json()).status).toBe("RUNNING");
      expect(reports).toHaveLength(0); // still running
      release();
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(reports[0]!.body.status).toBe("COMPLETED");
    } finally {
      release();
      await handle.close();
    }
  }, 15_000);

  it("a pushed cancel aborts the running action and reports CANCELLED", async () => {
    // The Platform has always dialled POST {route}/commands/:id/cancel; this
    // listener never implemented it, so the one thing that ends a running
    // action could not reach a World B action at all.
    let sawAbort = false;
    const { handle, reports } = await registered(
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
    );
    try {
      expect((await push(handle.port, "cmd_cancel_b")).status).toBe(202);
      const res = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_cancel_b/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_cancel_b" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The frozen CommandCancelResponse shape, so the Platform can validate
      // it before recording the cancel as delivered.
      expect(body).toMatchObject({ contractVersion: 1, commandId: "cmd_cancel_b", outcome: "CANCELLING", status: "RUNNING" });
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(sawAbort).toBe(true);
      expect(reports[0]!.body).toMatchObject({ status: "FAILED", failureReason: "CANCELLED" });
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("answers ALREADY_TERMINAL only for a command that really settled here", async () => {
    const { handle, reports } = await registered(() => ({ ok: true }));
    const cancel = (id: string) =>
      fetch(`http://127.0.0.1:${handle.port}/commands/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: id }),
      });
    try {
      // Run one to completion, then cancel it: genuinely over.
      await push(handle.port, "cmd_done");
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect((await (await cancel("cmd_done")).json()).outcome).toBe("ALREADY_TERMINAL");

      // A commandId never seen is NOT "already terminal": it may be a cancel
      // that arrived before its execute, and answering ALREADY_TERMINAL would
      // tell the Platform the cancel was applied while the execute then ran
      // anyway (review 2185).
      expect((await (await cancel("cmd_unheard_of")).json()).outcome).toBe("CANCELLING");
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("refuses the execute when its cancel arrived first", async () => {
    let ran = 0;
    const { handle, reports } = await registered(() => {
      ran += 1;
      return { ok: true };
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_early/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_early" }),
      });
      expect((await res.json()).outcome).toBe("CANCELLING");
      // The execute now turns up. It must not run.
      await push(handle.port, "cmd_early");
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(ran).toBe(0);
      expect(reports[0]!.body).toMatchObject({ status: "FAILED", failureReason: "CANCELLED" });
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("refuses a cancel that does not present the callback token", async () => {
    const { handle } = await registered(() => ({ ok: true }));
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_x/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

describe("one command, one execution on the push transport (review 2181)", () => {
  const manifestC = {
    contractVersion: 1,
    tenant: "default",
    service: { id: "demo-echo-service", name: "Demo", version: "0.1.0" },
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  } as const;

  async function registered(execute: (input: unknown, ctx?: { signal?: AbortSignal; commandId?: string }) => unknown) {
    const reports: { commandId: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const m = /\/commands\/([^/]+)\/result$/.exec(u);
      if (m) reports.push({ commandId: m[1]!, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestC as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute }],
      fetchImpl,
    });
    return { handle, reports };
  }

  const push = (port: number, commandId: string) =>
    fetch(`http://127.0.0.1:${port}/actions/ping/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": commandId },
      body: JSON.stringify({}),
    });

  it("a repeated push of the same commandId does not start a second run", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { handle, reports } = await registered(async () => {
      runs += 1;
      await gate;
      return { ok: true };
    });
    try {
      expect((await push(handle.port, "cmd_dup")).status).toBe(202);
      expect((await push(handle.port, "cmd_dup")).status).toBe(202); // acked, not re-run
      expect(runs).toBe(1);
      release();
      await vi.waitFor(() => expect(reports).toHaveLength(1));
    } finally {
      release();
      await handle.close();
    }
  }, 15_000);

  it("replays an outcome the Platform never accepted, without running the action again", async () => {
    // The action ran and its effect happened; only the Platform's knowledge is
    // missing. Settling there would leave the command RUNNING for ever with no
    // recovery — neither re-execution nor re-report (review 2188).
    let runs = 0;
    let acceptReports = false;
    const attempts: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        attempts.push(init?.body ? JSON.parse(String(init.body)) : {});
        if (!acceptReports) return new Response(JSON.stringify({ code: "BOOM" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestC as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: () => {
            runs += 1;
            return { ok: true };
          },
        },
      ],
      fetchImpl,
    });
    try {
      await push(handle.port, "cmd_owed");
      await vi.waitFor(() => expect(attempts).toHaveLength(1)); // reported, refused
      expect(runs).toBe(1);

      // The Platform redelivers because it never saw a result.
      acceptReports = true;
      await push(handle.port, "cmd_owed");
      await vi.waitFor(() => expect(attempts).toHaveLength(2));
      // Reported again, with the same outcome — and the action did NOT re-run.
      expect(runs).toBe(1);
      expect(attempts[1]).toMatchObject({ status: "COMPLETED" });
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("refuses a redelivery that arrives after the action already finished", async () => {
    // The map entry used to be deleted on completion, so a late redelivery was
    // indistinguishable from a first one and a side-effecting action ran twice
    // (review 2185). A settled command stays knowable.
    let runs = 0;
    const { handle, reports } = await registered(() => {
      runs += 1;
      return { ok: true };
    });
    try {
      await push(handle.port, "cmd_late");
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(runs).toBe(1);
      // Same commandId, delivered again well after the first settled.
      expect((await push(handle.port, "cmd_late")).status).toBe(202);
      await new Promise((r) => setTimeout(r, 100));
      expect(runs).toBe(1);
      expect(reports).toHaveLength(1);
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("a cancel after a repeated push still stops the run that is actually going", async () => {
    // Overwriting the map entry orphaned the first run's abort handle, so a
    // cancel stopped only the newcomer while the original ran on unstoppable.
    let aborted = 0;
    const { handle, reports } = await registered(
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          }, { once: true });
        }),
    );
    try {
      await push(handle.port, "cmd_dup2");
      await push(handle.port, "cmd_dup2");
      const res = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_dup2/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_dup2" }),
      });
      expect((await res.json()).outcome).toBe("CANCELLING");
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      expect(aborted).toBe(1); // one run existed, and it is the one that stopped
      expect(reports[0]!.body).toMatchObject({ status: "FAILED", failureReason: "CANCELLED" });
    } finally {
      await handle.close();
    }
  }, 15_000);
});

describe("listen-only tells the truth about a cancel (review 2181)", () => {
  const manifestD = {
    contractVersion: 1,
    tenant: "default",
    service: { id: "demo-echo-service", name: "Demo", version: "0.1.0" },
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  } as const;

  it("cancels a still-running action instead of claiming it already ended", async () => {
    // The synchronous branch registered nothing, so a cancel for a running
    // action found nothing and answered ALREADY_TERMINAL — the Platform then
    // recorded an undelivered cancel as delivered, against a command still
    // very much running.
    let aborted = false;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestD as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      listenOnly: true,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [
        {
          name: "ping",
          label: "Ping",
          execute: (_input, ctx) =>
            new Promise((_resolve, reject) => {
              ctx?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              }, { once: true });
            }),
        },
      ],
    });
    try {
      const running = fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_lo" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_lo/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
          body: JSON.stringify({ contractVersion: 1, commandId: "cmd_lo" }),
        });
        expect((await res.json()).outcome).toBe("CANCELLING");
      });
      expect((await running).status).toBe(409);
      expect(aborted).toBe(true);
    } finally {
      await handle.close();
    }
  }, 15_000);
});

describe("terminal outcomes are retried by their own owner (review 2191)", () => {
  const manifestE = {
    contractVersion: 1,
    tenant: "default",
    service: { id: "demo-echo-service", name: "Demo", version: "0.1.0" },
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  } as const;

  it("keeps re-reporting on its own cadence, with no redelivery to trigger it", async () => {
    // World A acks the COMMAND and long-poll dedupe suppresses it, so nothing
    // redelivers. Without an owner, "replay until accepted" meant "wait for a
    // coincidence" (review 2191).
    let attempts = 0;
    let accept = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        attempts += 1;
        if (!accept) return new Response(JSON.stringify({ code: "BOOM" }), { status: 503, headers: { "content-type": "application/json" } });
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "APPLIED", status: "COMPLETED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 2_000, // retry cadence is half of this
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_retry" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));
      // Nothing redelivers the command; the retry owner alone drives this.
      await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: 12_000 });
      accept = true;
      const settledAt = attempts;
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(settledAt), { timeout: 12_000 });
      // Once accepted it stops: no further attempts after a short wait.
      const afterAccept = attempts;
      await new Promise((r) => setTimeout(r, 2_500));
      expect(attempts).toBe(afterAccept);
    } finally {
      await handle.close();
    }
  }, 40_000);

  it("does not retry a refusal the Platform will keep giving", async () => {
    // UNKNOWN_COMMAND arrives with a 200. Treating the status code as
    // acceptance dropped the outcome silently; treating the refusal as a
    // transport failure would retry it for ever. Neither: settle and surface.
    let attempts = 0;
    const rejected: { reason: string }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        attempts += 1;
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "UNKNOWN_COMMAND" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 2_000,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      onReportRejected: (info) => rejected.push({ reason: info.reason }),
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_unknown" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(rejected).toHaveLength(1));
      expect(rejected[0]!.reason).toBe("UNKNOWN_COMMAND");
      const once = attempts;
      await new Promise((r) => setTimeout(r, 2_500));
      expect(attempts).toBe(once); // not retried
    } finally {
      await handle.close();
    }
  }, 20_000);

  it("classifies a permanent HTTP refusal on the legacy report path as rejected, not transient", async () => {
    // The legacy dialect (plain COMPLETED, no failureReason) is refused with a
    // raw 4xx, not the frozen union. Turning that into a generic exception put
    // it in the transient bucket: retried for ever, onReportRejected never
    // fired (review 2194).
    let attempts = 0;
    const rejected: { reason: string }[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        attempts += 1;
        return new Response(JSON.stringify({ code: "UNKNOWN_COMMAND", message: "no such command" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 2_000,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      onReportRejected: (info) => rejected.push({ reason: info.reason }),
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_http404" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(rejected).toHaveLength(1));
      expect(rejected[0]!.reason).toBe("HTTP_REJECTED");
      const once = attempts;
      await new Promise((r) => setTimeout(r, 2_500));
      expect(attempts).toBe(once); // permanent: not retried
    } finally {
      await handle.close();
    }
  }, 20_000);

  it("still treats a 5xx on the report as transient and keeps the outcome owed", async () => {
    // The counter-case that keeps the classification honest: an outage is NOT
    // an answer, and the retry owner must keep going.
    let attempts = 0;
    let accept = false;
    const rejected: unknown[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        attempts += 1;
        if (!accept) return new Response("boom", { status: 503 });
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "APPLIED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 2_000,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      onReportRejected: () => rejected.push(1),
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_http503" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: 12_000 }); // retried
      accept = true;
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(2), { timeout: 12_000 });
      expect(rejected).toHaveLength(0); // never mistaken for a refusal
    } finally {
      await handle.close();
    }
  }, 40_000);

  it("a later cancel answers with the Platform's terminal status, not the local one", async () => {
    // The 2201 scenario end to end: this connector reports COMPLETED, but the
    // Platform had already FAILED the command and answers
    // ALREADY_TERMINAL/FAILED. The tombstone must hold FAILED — a /cancel
    // that answered COMPLETED off the local report contradicted the authority.
    let reported = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        reported = true;
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return new Response(
          JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "ALREADY_TERMINAL", status: "FAILED" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }], // locally COMPLETED
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_authority" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(reported).toBe(true));
      const cancel = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_authority/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_authority" }),
      });
      const answer = (await cancel.json()) as { outcome: string; status?: string };
      expect(answer.outcome).toBe("ALREADY_TERMINAL");
      expect(answer.status).toBe("FAILED"); // the Platform's status, not this process's COMPLETED
    } finally {
      await handle.close();
    }
  }, 20_000);

  it("push: a cancel that beat the execute wins over ACTION_NOT_FOUND too (review 2207)", async () => {
    // The World B half of review 2205. The handler classified before
    // admitting: a CANCEL had arrived first (answered CANCELLING off the
    // registry), then the EXECUTE for a nonexistent action was 404'd without
    // ever consulting the registry — and the Platform settled
    // FAILED(ACTION_NOT_FOUND) over an accepted cancellation.
    const reports: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "APPLIED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    try {
      const cancel = await fetch(`http://127.0.0.1:${handle.port}/commands/cmd_first/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
        body: JSON.stringify({ contractVersion: 1, commandId: "cmd_first" }),
      });
      expect(((await cancel.json()) as { outcome: string }).outcome).toBe("CANCELLING");

      // The EXECUTE arrives late, for an action that does not exist.
      const exec = await fetch(`http://127.0.0.1:${handle.port}/actions/no-such-action/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_first" },
        body: JSON.stringify({}),
      });
      // Admission answers, not classification: the ack, then the CANCELLED report.
      expect(exec.status).toBe(202);
      await vi.waitFor(() => expect(reports.length).toBeGreaterThanOrEqual(1));
      expect(reports[0]).toMatchObject({ commandId: "cmd_first", status: "FAILED", failureReason: "CANCELLED" });
      expect(reports[0]!.errorCode).not.toBe("ACTION_NOT_FOUND");
    } finally {
      await handle.close();
    }
  }, 20_000);

  it("push: a settled command redelivered after its action vanished stays deduped (review 2207)", async () => {
    // The other order the review named: already settled here, action since
    // removed from the catalog. Classification-first re-reported it as
    // ACTION_NOT_FOUND; admission-first refuses the duplicate outright.
    const reports: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "APPLIED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{ name: "ping", label: "Ping", execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    try {
      await fetch(`http://127.0.0.1:${handle.port}/actions/ping/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_dup" },
        body: JSON.stringify({}),
      });
      await vi.waitFor(() => expect(reports.length).toBe(1)); // settled COMPLETED

      // Redelivery of the same commandId, but the URL names a vanished action.
      const redelivery = await fetch(`http://127.0.0.1:${handle.port}/actions/gone-action/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_dup" },
        body: JSON.stringify({}),
      });
      expect(redelivery.status).toBe(202); // deduped ack, not a 404 reclassification
      await new Promise((r) => setTimeout(r, 300));
      expect(reports.length).toBe(1); // and no second report of any kind
    } finally {
      await handle.close();
    }
  }, 20_000);

  it("push: a cancel landing during the body read stops the action before it starts (review 2208)", async () => {
    // The window the 2207 fix opened: admission now precedes the body read,
    // so a CANCEL can arrive while the body is in flight — signal aborted,
    // CANCELLING answered — and the handler then parsed and called
    // action.execute() anyway, checking the signal only afterwards. The
    // reviewer's exact recipe: partial body, hold the connection, cancel,
    // then complete the body.
    const reports: Record<string, unknown>[] = [];
    let executeCalled = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/\/commands\/[^/]+\/result$/.test(u)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ contractVersion: 1, commandId: body.commandId, outcome: "APPLIED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ instanceId: "demo-1", accessToken: "xtrape_at_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: manifestE as never,
      host: "127.0.0.1",
      heartbeatMs: 0,
      callbackToken: "tok",
      handler: () => "ok",
      actions: [{
        name: "ping",
        label: "Ping",
        // Deliberately signal-blind: the guard must protect even this action.
        execute: () => {
          executeCalled = true;
          return { ok: true };
        },
      }],
      fetchImpl,
    });
    try {
      // Partial body over chunked encoding; the server admits on headers and
      // then awaits the rest.
      const execResponse = new Promise<{ status: number }>((resolve, reject) => {
        const r = httpRequest(
          {
            host: "127.0.0.1",
            port: handle.port,
            path: "/actions/ping/execute",
            method: "POST",
            headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok", "x-xtrape-command-id": "cmd_bodyrace" },
          },
          (res) => resolve({ status: res.statusCode ?? 0 }),
        );
        r.on("error", reject);
        r.write('{"probe"');
        // Cancel while the body is in flight, then complete it.
        setTimeout(() => {
          void fetch(`http://127.0.0.1:${handle.port}/commands/cmd_bodyrace/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "tok" },
            body: JSON.stringify({ contractVersion: 1, commandId: "cmd_bodyrace" }),
          }).then(async (cancel) => {
            expect(((await cancel.json()) as { outcome: string }).outcome).toBe("CANCELLING");
            r.end(': 1}');
          });
        }, 150);
      });
      const { status } = await execResponse;
      expect(status).toBe(202); // the registered path acks; the report carries the truth
      await vi.waitFor(() => expect(reports.length).toBeGreaterThanOrEqual(1));
      expect(reports[0]).toMatchObject({ commandId: "cmd_bodyrace", status: "FAILED", failureReason: "CANCELLED" });
      // The whole point: the business action never ran.
      expect(executeCalled).toBe(false);
    } finally {
      await handle.close();
    }
  }, 20_000);
});

describe("online Checkpoint growth (connector-nodejs#98)", () => {
  const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"; // sha256("{}")
  const definition = (checkpointId: string, actionId: string) => ({
    contractVersion: 1 as const,
    id: { serviceId: manifest.service.id, checkpointId, checkpointVersion: "1.0.0" },
    inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
    resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
    sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
    sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
    idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
    retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const,
    action: { actionId },
    localPreconditions: [],
  });

  function governedFakePlatform() {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = String(url).endsWith("/v1/instances")
        ? { instanceId: "i1", contractVersion: 1, accessToken: "xtrape_at_grow" }
        : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("a grown Checkpoint publishes durably FIRST, joins the validation set, and a live action may then bind it", async () => {
    const { calls, fetchImpl } = governedFakePlatform();
    const live: NonNullable<Parameters<typeof serveCeService>[0]["actions"]> = [
      { name: "seedTask", label: "Seed", checkpoint: definition("task.seed", "seedTask").id, execute: () => ({ ok: true }) },
    ];
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [definition("task.seed", "seedTask")],
      actions: live,
      fetchImpl,
    });
    const names = async () => ((await (await fetch(`${handle!.address}/actions`)).json()) as Array<{ name: string }>).map((a) => a.name);
    expect(await names()).toEqual(["seedTask"]);

    // Enabling a library task online: publish its Checkpoint, then bind it.
    const before = calls.length;
    await handle.publishCheckpoints([definition("task.disk-usage", "diskUsage")]);
    const published = calls.slice(before).map((c) => c.url);
    expect(published.some((u) => u.includes("/checkpoints"))).toBe(true);
    live.push({ name: "diskUsage", label: "Disk usage", checkpoint: definition("task.disk-usage", "diskUsage").id, execute: () => ({ ok: true }) });
    expect(await names()).toEqual(["seedTask", "diskUsage"]);

    // The RE-registration descriptor rebuilds from the GROWN set.
    // (authorityDescriptor reads the same arrays the growth merged into.)
    await handle.publishCheckpoints([]).catch(() => {}); // no-op growth is legal
    // Duplicate growth is refused BEFORE any durable call.
    const at = calls.length;
    await expect(handle.publishCheckpoints([definition("task.disk-usage", "diskUsage")])).rejects.toThrow(/duplicate Checkpoint/);
    expect(calls.length).toBe(at);

    // An unknown schema reference is refused before any durable call too.
    const bad = definition("task.bad", "badTask");
    bad.inputSchema = { schemaRecord: `sha256:${"9".repeat(64)}` };
    await expect(handle.publishCheckpoints([bad])).rejects.toThrow(/absent from this Service descriptor/);
  });

  it("review 2669: an intra-batch duplicate is refused BEFORE any durable call — the local sets can never diverge into [A,A]/{A}", async () => {
    const { calls, fetchImpl } = governedFakePlatform();
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [definition("task.seed", "seedTask")],
      actions: [{ name: "seedTask", label: "Seed", checkpoint: definition("task.seed", "seedTask").id, execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    const before = calls.length;
    const dup = definition("task.same", "sameTask");
    await expect(handle.publishCheckpoints([dup, definition("task.same", "sameTask")])).rejects.toThrow(/duplicate Checkpoint definition in this batch/);
    expect(calls.length).toBe(before); // zero durable mutation
    // duplicate schema records in one batch are refused the same way
    await expect(
      handle.publishCheckpoints([], [
        { bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest },
        { bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest },
      ]),
    ).rejects.toThrow(/duplicate schema record in this batch/);
    // an ALREADY-KNOWN digest is an idempotent skip: no durable call, no second local row
    const at = calls.length;
    await handle.publishCheckpoints([], [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }]);
    expect(calls.length).toBe(at);
  });

  it("review 2669: concurrent identical growth serializes — one wins, the other re-preflights against the merged snapshot and is refused pre-durable", async () => {
    const { calls, fetchImpl } = governedFakePlatform();
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: [definition("task.seed", "seedTask")],
      actions: [{ name: "seedTask", label: "Seed", checkpoint: definition("task.seed", "seedTask").id, execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    const before = calls.length;
    const results = await Promise.allSettled([
      handle.publishCheckpoints([definition("task.race", "raceTask")]),
      handle.publishCheckpoints([definition("task.race", "raceTask")]),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("duplicate Checkpoint definition");
    // exactly ONE durable checkpoint publish happened for task.race
    const publishes = calls.slice(before).filter((c) => c.url.includes("/checkpoints"));
    expect(publishes).toHaveLength(1);
  });
});

describe("checkpoints FACTORY — definitions built AFTER registration (connector-nodejs#100)", () => {
  const digest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"; // sha256("{}")
  const definition = (checkpointId: string, actionId: string) => ({
    contractVersion: 1 as const,
    id: { serviceId: manifest.service.id, checkpointId, checkpointVersion: "1.0.0" },
    inputSchema: { schemaRecord: digest }, outputSchema: { schemaRecord: digest },
    resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
    sideEffect: "READ_ONLY" as const, risk: "LOW" as const,
    sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
    idempotency: "IDEMPOTENT" as const, delivery: "AT_LEAST_ONCE" as const,
    retry: "IDEMPOTENT_REPLAY" as const, execution: "SYNC" as const,
    action: { actionId },
    localPreconditions: [],
  });
  function governedFake() {
    const calls: { url: string; body?: unknown; headers?: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers as Record<string, string>) ?? {} });
      const u = String(url);
      const body = u.endsWith("/v1/instances")
        ? { instanceId: "i9", contractVersion: 1, accessToken: "xtrape_at_factory" }
        : u.includes("/resource-extractor-execution-profiles")
          ? { profiles: [{ digest: `sha256:${"7".repeat(64)}`, bytesJson: "{}", profile: {}, createdAt: "2026-08-25T00:00:00.000Z" }] }
          : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("the factory runs against the BOUNDED facade (never the raw credential); its definitions ride the registration descriptor and bound actions validate after it", async () => {
    const { calls, fetchImpl } = governedFake();
    let seen: { instanceId: string; profileDigest?: string; keys: string[] } | undefined;
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }],
      checkpoints: async (ctx) => {
        // The bootstrap seam, whole and nothing more: discover the admitted
        // profile digest (platform-ce#262), publish the artifact, answer with
        // definitions. The raw instance credential is NOT reachable here
        // (review 2671) — the facade's keys are asserted below.
        seen = { instanceId: ctx.instanceId, keys: Object.keys(ctx).sort() };
        const listing = await ctx.listExecutionProfiles();
        seen.profileDigest = listing.profiles[0]?.digest;
        await ctx.publishResourceExtractorArtifact({ bytesJson: "{}", mediaType: "application/vnd.xtrape.static-resource-extractor.v1+json" });
        return [definition("factory.status", "factoryStatus")];
      },
      actions: [{ name: "factoryStatus", label: "F", checkpoint: definition("factory.status", "factoryStatus").id, execute: () => ({ ok: true }) }],
      fetchImpl,
    });
    expect(seen?.keys).toEqual(["instanceId", "listExecutionProfiles", "publishResourceExtractorArtifact"]);
    expect(seen?.profileDigest).toBe(`sha256:${"7".repeat(64)}`);
    expect(seen?.instanceId).toMatch(/^demo-echo-service-/); // the connector's registered instance id
    // the facade's calls rode the platform routes with the instance credential
    expect(calls.some((c) => c.url.includes("/resource-extractor-execution-profiles") && c.headers?.["x-xtrape-access-token"] === "xtrape_at_factory")).toBe(true);
    expect(calls.some((c) => c.url.includes("/resource-extractor-artifacts") && c.headers?.["x-xtrape-access-token"] === "xtrape_at_factory")).toBe(true);
    // registration happened BEFORE the descriptor carrying the factory's output
    const registerAt = calls.findIndex((c) => c.url.endsWith("/v1/instances"));
    const descriptorAt = calls.findIndex((c) => JSON.stringify(c.body ?? {}).includes("factory.status"));
    expect(registerAt).toBeGreaterThanOrEqual(0);
    expect(descriptorAt).toBeGreaterThan(registerAt);
    const names = ((await (await fetch(`${handle.address}/actions`)).json()) as Array<{ name: string }>).map((a) => a.name);
    expect(names).toEqual(["factoryStatus"]);
  });

  it("a listen-only (World B) service refuses a factory — there is no registration to contextualize it", async () => {
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000", manifest, handler: () => "ok", listenOnly: true,
        callbackToken: "wb-issued", port: 0, host: "127.0.0.1",
        checkpoints: async () => [],
      }),
    ).rejects.toThrow(/listen-only/);
  });
});

describe("per-action timeoutSeconds disclosure reaches the catalog (connector-nodejs#76; reminder metadata, not a budget)", () => {
  it("a positive integer disclosure is served verbatim on GET /actions; a malformed one is dropped", async () => {
    const { fetchImpl } = fakePlatformCe();
    handle = await serveCeService({
      serverUrl: "http://srv:3000", manifest, host: "127.0.0.1", heartbeatMs: 0, handler: () => "ok",
      actions: [
        { name: "quick", label: "Quick", timeoutSeconds: 30, execute: () => ({ ok: true }) },
        { name: "fractional", label: "Fractional", timeoutSeconds: 1.5, execute: () => ({ ok: true }) },
        { name: "zero", label: "Zero", timeoutSeconds: 0, execute: () => ({ ok: true }) },
        { name: "unset", label: "Unset", execute: () => ({ ok: true }) },
      ],
      fetchImpl,
    });
    const catalog = (await (await fetch(`${handle.address}/actions`)).json()) as Array<{ name: string; timeoutSeconds?: number }>;
    const byName = new Map(catalog.map((a) => [a.name, a]));
    expect(byName.get("quick")!.timeoutSeconds).toBe(30);
    // a non-integer, a non-positive, and an absent budget all serve NO field
    expect(byName.get("fractional")!.timeoutSeconds).toBeUndefined();
    expect(byName.get("zero")!.timeoutSeconds).toBeUndefined();
    expect(byName.get("unset")!.timeoutSeconds).toBeUndefined();
  });
});

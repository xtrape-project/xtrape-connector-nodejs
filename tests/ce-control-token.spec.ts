import { afterEach, describe, expect, it } from "vitest";
import { CeServiceConnector, serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

function fakeFetch() {
  const calls: { url: string; method?: string; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const validMessage = JSON.stringify({
  contractVersion: 1,
  messageId: "m1",
  conversationId: "c1",
  targetType: "SERVICE",
  targetId: "demo-echo-service",
  senderType: "USER",
  senderId: "u1",
  messageType: "QUERY",
  content: "ping",
});

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("CeServiceConnector control token (server-ce#12)", () => {
  it("sends x-xtrape-control-token on heartbeat and deregister when configured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({
      serverUrl: "http://srv:3000",
      manifest,
      address: "http://10.0.0.5:8080",
      instanceId: "i1",
      controlToken: "ctl",
      fetchImpl,
    });
    await connector.sendHeartbeat();
    await connector.deregister();
    expect(calls[0].url).toContain("/v1/instances/i1/heartbeat");
    expect(calls[0].headers?.["x-xtrape-control-token"]).toBe("ctl");
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].headers?.["x-xtrape-control-token"]).toBe("ctl");
  });

  it("omits the control token header when not configured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({
      serverUrl: "http://srv:3000",
      manifest,
      address: "http://10.0.0.5:8080",
      instanceId: "i1",
      fetchImpl,
    });
    await connector.sendHeartbeat();
    expect(calls[0].headers?.["x-xtrape-control-token"]).toBeUndefined();
  });
});

describe("serveCeService control + callback token", () => {
  it("forwards controlToken into the connector (heartbeat carries the header)", async () => {
    const { calls, fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      controlToken: "ctl",
      fetchImpl,
    });
    await handle.connector.sendHeartbeat();
    const hb = calls.find((c) => c.url.includes("/heartbeat"));
    expect(hb?.headers?.["x-xtrape-control-token"]).toBe("ctl");
  });

  it("rejects /messages with a missing callback token when configured", async () => {
    const { fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      callbackToken: "cb",
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validMessage,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("rejects /messages with a wrong callback token", async () => {
    const { fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      callbackToken: "cb",
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "wrong" },
      body: validMessage,
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct callback token (header and Bearer)", async () => {
    const { fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: (m) => `echo: ${m.content}`,
      callbackToken: "cb",
      fetchImpl,
    });
    const viaHeader = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtrape-service-callback-token": "cb" },
      body: validMessage,
    });
    expect(viaHeader.status).toBe(200);

    const viaBearer = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cb" },
      body: validMessage,
    });
    expect(viaBearer.status).toBe(200);
  });

  it("serves /messages without a token when callbackToken is not configured", async () => {
    const { fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      fetchImpl,
    });
    const res = await fetch(`${handle.address}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validMessage,
    });
    expect(res.status).toBe(200);
  });

  it("protects action list/prepare/execute endpoints with callbackToken", async () => {
    const { fetchImpl } = fakeFetch();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      host: "127.0.0.1",
      heartbeatMs: 0,
      handler: () => "ok",
      callbackToken: "cb",
      actions: [
        {
          name: "relogin",
          label: "Re-login",
          prepare: () => ({ initialPayload: { accountId: "acc-1" } }),
          execute: () => ({ ok: true }),
        },
      ],
      fetchImpl,
    });

    expect((await fetch(`${handle.address}/actions`)).status).toBe(401);
    expect((await fetch(`${handle.address}/actions`, { headers: { "x-xtrape-service-callback-token": "wrong" } })).status).toBe(401);
    expect((await fetch(`${handle.address}/actions`, { headers: { "x-xtrape-service-callback-token": "cb" } })).status).toBe(200);

    expect((await fetch(`${handle.address}/actions/relogin/prepare`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${handle.address}/actions/relogin/prepare`, { method: "POST", headers: { authorization: "Bearer cb" } })).status).toBe(200);

    expect((await fetch(`${handle.address}/actions/relogin/execute`, { method: "POST", headers: { "x-xtrape-service-callback-token": "wrong" } })).status).toBe(401);
    expect((await fetch(`${handle.address}/actions/relogin/execute`, { method: "POST", headers: { "x-xtrape-service-callback-token": "cb" } })).status).toBe(200);
  });
});

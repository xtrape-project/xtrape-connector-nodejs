import { afterEach, describe, expect, it } from "vitest";
import { serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

/**
 * Platform-minted per-instance callback credential (docs#122, contracts#82):
 * when the registration response carries `callbackToken`, the SDK adopts it
 * for inbound authentication — the Platform proves itself with a credential no
 * other service can derive, and the operator configures nothing.
 */

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

/** Fake platform-ce whose registration response mints a callback token. */
function fakePlatformCe(mintedCallbackToken?: string) {
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).endsWith("/v1/instances")) {
      return new Response(
        JSON.stringify({
          contractVersion: 1,
          instanceId: "inst-cb",
          accessToken: "xtrape_at_test",
          ...(mintedCallbackToken ? { callbackToken: mintedCallbackToken } : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return fetchImpl;
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

async function postMessage(address: string, token?: string): Promise<number> {
  const res = await fetch(`${address}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-xtrape-service-callback-token": token } : {}),
    },
    body: validMessage,
  });
  return res.status;
}

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("Platform-minted callback token adoption (docs#122)", () => {
  it("enforces the minted token on inbound calls with zero configuration", async () => {
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      fetchImpl: fakePlatformCe("xtrape_cb_minted"),
      port: 0,
      host: "127.0.0.1",
    });
    expect(await postMessage(handle.address)).toBe(401);
    expect(await postMessage(handle.address, "xtrape_cb_wrong")).toBe(401);
    expect(await postMessage(handle.address, "xtrape_cb_minted")).toBe(200);
  });

  it("lets the minted token supersede a statically configured one", async () => {
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      callbackToken: "static-configured",
      fetchImpl: fakePlatformCe("xtrape_cb_minted"),
      port: 0,
      host: "127.0.0.1",
    });
    // The stale static value no longer authenticates — the Platform-minted
    // credential is the per-instance one; keeping both live would defeat it.
    expect(await postMessage(handle.address, "static-configured")).toBe(401);
    expect(await postMessage(handle.address, "xtrape_cb_minted")).toBe(200);
  });

  it("keeps the configured behavior when the Platform mints nothing", async () => {
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      callbackToken: "static-configured",
      fetchImpl: fakePlatformCe(undefined),
      port: 0,
      host: "127.0.0.1",
    });
    expect(await postMessage(handle.address, "static-configured")).toBe(200);
    expect(await postMessage(handle.address)).toBe(401);
  });
});

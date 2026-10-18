import { afterEach, describe, expect, it } from "vitest";
import { CeServiceConnector, serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

/**
 * Review #71 blockers, pinned over real HTTP:
 *
 * 1. The adoption declaration is truthful: bare CeServiceConnector (a service
 *    running its own listener the SDK does not guard) must NOT declare;
 *    serveCeService (which owns and guards the listener) must.
 * 2. Re-registration ROTATES the enforced credential: the token minted by the
 *    first registration must stop working the moment a re-registration adopts
 *    a new one — a value captured at first registration would keep accepting
 *    the retired credential forever.
 */

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "rot-svc", name: "Rot Svc", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

/** Fake platform-ce minting a fresh callback token per registration. */
function mintingServer(tokens: string[]) {
  const registrations: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/instances") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { instance: Record<string, unknown> };
      registrations.push(body.instance);
      const callbackToken = tokens[Math.min(n, tokens.length - 1)];
      n += 1;
      return new Response(
        JSON.stringify({ contractVersion: 1, instanceId: "rot-1", accessToken: `at-${n}`, callbackToken }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { registrations, fetchImpl };
}

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("adoption declaration is made by whoever guards the listener (#71 blocker 1)", () => {
  it("bare CeServiceConnector does NOT declare unless the caller opts in", () => {
    const bare = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://self:1" });
    expect(bare.instance().supportsCallbackToken).toBeUndefined();

    const optedIn = new CeServiceConnector({
      serverUrl: "http://srv:3000",
      manifest,
      address: "http://self:1",
      declareCallbackTokenSupport: true,
    });
    expect(optedIn.instance().supportsCallbackToken).toBe(true);
  });

  it("serveCeService declares, because it owns and guards the HTTP surface", async () => {
    const srv = mintingServer(["tok-A"]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      fetchImpl: srv.fetchImpl,
      port: 0,
      host: "127.0.0.1",
    });
    expect(srv.registrations[0]?.supportsCallbackToken).toBe(true);
  });
});

describe("re-registration rotates the enforced credential (#71 blocker 2)", () => {
  it("token A works, then re-register: A must 401 and B must 200", async () => {
    const srv = mintingServer(["tok-A", "tok-B"]);
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest,
      handler: () => "ok",
      actions: [{ name: "noop", label: "Noop", execute: () => ({ ok: true }) }],
      fetchImpl: srv.fetchImpl,
      port: 0,
      host: "127.0.0.1",
    });

    const probe = (token?: string) =>
      fetch(`${handle!.address}/actions`, {
        headers: token ? { "x-xtrape-service-callback-token": token } : undefined,
      });

    expect((await probe("tok-A")).status).toBe(200);
    expect((await probe("tok-B")).status).toBe(401);
    expect((await probe()).status).toBe(401);

    // The operator-visible act that rotates: registering again.
    await handle.connector.register();

    expect((await probe("tok-A")).status).toBe(401);
    expect((await probe("tok-B")).status).toBe(200);
  });
});

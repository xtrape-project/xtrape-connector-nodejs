import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeBuildArtifactDigest, serveCeService, type ServeCeServiceHandle } from "../src/index";
import type { ServiceManifest } from "@xtrape/contracts";

/**
 * serveCeService-level integration of the self-reported build identity
 * (review 2747 P1): the unit suite proves the DIGEST; this suite proves the
 * PATH — buildRoot -> computed digest -> manifest.build -> what the Platform
 * actually receives at registration (and what a World B descriptor serves),
 * plus the fail-closed refusal when a hand-written manifest digest
 * contradicts the bytes, BEFORE any registration request leaves.
 */

const baseManifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

/** Fake platform-ce that records every call and answers registration. */
function fakePlatform() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/v1/instances") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ contractVersion: 1, instanceId: "inst-bi", accessToken: "xtrape_at_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const registrations = () => calls.filter((c) => c.url.endsWith("/v1/instances") && c.method === "POST");
  return { calls, fetchImpl, registrations };
}

const dirs: string[] = [];
async function scratchDist(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ce-build-identity-"));
  dirs.push(d);
  await writeFile(join(d, "index.js"), "console.log('widget')\n");
  await writeFile(join(d, "util.js"), "module.exports = 1\n");
  return d;
}

let handle: ServeCeServiceHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("build identity through serveCeService (review 2747)", () => {
  it("buildRoot -> computed digest -> manifest.build -> the registration the Platform receives", async () => {
    const root = await scratchDist();
    const expected = computeBuildArtifactDigest(root).artifactDigest;
    const srv = fakePlatform();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: baseManifest,
      handler: () => "ok",
      fetchImpl: srv.fetchImpl,
      buildRoot: root,
      port: 0,
      host: "127.0.0.1",
    });
    const reg = srv.registrations();
    expect(reg).toHaveLength(1);
    const sent = (reg[0]!.body as { manifest: ServiceManifest }).manifest;
    expect(sent.build?.artifactDigest).toBe(expected);
  });

  it("a manifest digest that contradicts the bytes fails CLOSED before any registration request", async () => {
    const root = await scratchDist();
    const srv = fakePlatform();
    await expect(
      serveCeService({
        serverUrl: "http://srv:3000",
        manifest: { ...baseManifest, build: { artifactDigest: `sha256:${"f".repeat(64)}` } },
        handler: () => "ok",
        fetchImpl: srv.fetchImpl,
        buildRoot: root,
        port: 0,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(/disagrees with the identity computed over buildRoot/);
    // fail-closed BEFORE the wire: the Platform never saw a registration
    expect(srv.registrations()).toHaveLength(0);
  });

  it("an explicit manifest.build (no buildRoot) rides through verbatim", async () => {
    const declared = `sha256:${"a".repeat(64)}`;
    const srv = fakePlatform();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: { ...baseManifest, build: { artifactDigest: declared } },
      handler: () => "ok",
      fetchImpl: srv.fetchImpl,
      port: 0,
      host: "127.0.0.1",
    });
    const sent = (srv.registrations()[0]!.body as { manifest: ServiceManifest }).manifest;
    expect(sent.build?.artifactDigest).toBe(declared);
  });

  it("legacy shape unchanged: no buildRoot, no build -> the registration carries no build key", async () => {
    const srv = fakePlatform();
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: baseManifest,
      handler: () => "ok",
      fetchImpl: srv.fetchImpl,
      port: 0,
      host: "127.0.0.1",
    });
    const sent = (srv.registrations()[0]!.body as { manifest: ServiceManifest }).manifest;
    expect("build" in sent).toBe(false);
  });

  it("a World B (listen-only) descriptor serves the computed identity too", async () => {
    const root = await scratchDist();
    const expected = computeBuildArtifactDigest(root).artifactDigest;
    // The descriptor is served only for a GOVERNED surface — give this
    // listen-only service the minimal one (same shape as ce-listen-only's).
    const schemaDigest = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const checkpoint = {
      contractVersion: 1 as const,
      id: { serviceId: "demo-echo-service", checkpointId: "status.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: schemaDigest },
      outputSchema: { schemaRecord: schemaDigest },
      resourceExtraction: { kind: "extractor-artifact" as const, artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY" as const,
      risk: "LOW" as const,
      sensitivity: { inputUpperBound: "INTERNAL" as const, outputUpperBound: "INTERNAL" as const },
      idempotency: "IDEMPOTENT" as const,
      delivery: "AT_LEAST_ONCE" as const,
      retry: "IDEMPOTENT_REPLAY" as const,
      execution: "SYNC" as const,
      action: { actionId: "getStatus" },
      localPreconditions: [],
    };
    handle = await serveCeService({
      serverUrl: "http://srv:3000",
      manifest: baseManifest,
      handler: () => "ok",
      listenOnly: true,
      callbackToken: "wb-issued",
      buildRoot: root,
      port: 0,
      host: "127.0.0.1",
      schemaRecords: [{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest: schemaDigest }],
      checkpoints: [checkpoint],
      actions: [{ name: "getStatus", label: "Get status", checkpoint: checkpoint.id, execute: () => ({ ok: true }) }],
    });
    const response = await fetch(`${handle.address}/descriptor`, { headers: { authorization: "Bearer wb-issued" } });
    expect(response.status).toBe(200);
    const descriptor = (await response.json()) as { manifest: ServiceManifest };
    expect(descriptor.manifest.build?.artifactDigest).toBe(expected);
  });
});

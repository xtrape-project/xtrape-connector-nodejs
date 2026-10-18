import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorApiClient } from "../src/client/connector-api-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ConnectorApiClient Worker reports", () => {
  it("falls back to the legacy service report after a canonical 404", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path.endsWith("/workers/report")) {
        return new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { services: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const worker = {
      code: "demo",
      name: "Demo",
      version: "1.0.0",
      runtime: "nodejs",
      manifest: { kind: "Worker", code: "demo", name: "Demo", version: "1.0.0", runtime: "nodejs" },
    };
    // `agt_test` is a wire connector id fixture; routes stay under /api/agents/*.
    await new ConnectorApiClient("http://panel.test").reportWorkers("agt_test", "token", { workers: [worker] });

    expect(requests).toEqual([
      { path: "/api/agents/agt_test/workers/report", body: { workers: [worker] } },
      { path: "/api/agents/agt_test/services/report", body: { services: [worker] } },
    ]);
  });
});

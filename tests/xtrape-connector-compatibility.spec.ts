import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";
import { XtrapeConnector } from "../src/index.js";

describe("XtrapeConnector canonical API (docs#100 D1: Capsule-era aliases removed)", () => {
  it("no longer exports any Capsule-era identifier", () => {
    const capsuleExports = Object.keys(pkg).filter((k) => /capsule/i.test(k));
    expect(capsuleExports).toEqual([]);
  });

  it("accepts a Worker definition under the canonical class", () => {
    const connector = new XtrapeConnector({
      backendUrl: "http://localhost:8080",
      worker: {
        code: "demo-worker",
        name: "Demo Worker",
        version: "1.0.0",
        runtime: "nodejs",
      },
      intervals: { workerReportMs: 60_000 },
      autoStartLoops: false,
    });

    expect(connector).toBeInstanceOf(XtrapeConnector);
  });
});

describe("connector-nodejs#79 deprecated Agent-named aliases", () => {
  it("every deprecated alias is the same runtime value as its canonical primary", () => {
    expect(pkg.XtrapeAgent).toBe(pkg.XtrapeConnector);
    expect(pkg.CeServiceAgent).toBe(pkg.CeServiceConnector);
    expect(pkg.AgentApiClient).toBe(pkg.ConnectorApiClient);
    expect(pkg.AgentApiError).toBe(pkg.ConnectorApiError);
    expect(pkg.AgentAuthError).toBe(pkg.ConnectorAuthError);
  });

  it("instanceof works across the alias pair for the error family", () => {
    const err = new pkg.ConnectorAuthError("nope", 401);
    expect(err).toBeInstanceOf(pkg.AgentAuthError);
    expect(err).toBeInstanceOf(pkg.ConnectorApiError);
    expect(err).toBeInstanceOf(pkg.AgentApiError);
    // Runtime `name` strings are frozen wire-adjacent behavior.
    expect(err.name).toBe("AgentAuthError");
  });
});

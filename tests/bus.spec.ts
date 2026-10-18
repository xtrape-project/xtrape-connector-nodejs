import { describe, expect, it } from "vitest";
import { XtrapeConnector } from "../src/xtrape-connector";

describe("experimental Bus hooks", () => {
  it("requires the connector to be started before publishing", async () => {
    const connector = new XtrapeConnector({
      backendUrl: "http://127.0.0.1:1",
      worker: { code: "demo-worker", name: "Demo Worker", version: "0.6.0", runtime: "nodejs" },
      autoStartLoops: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await expect(connector.publishBusEvent({ eventType: "demo.item.created" })).rejects.toThrow("started");
  });
});

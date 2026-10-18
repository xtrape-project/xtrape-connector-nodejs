import { describe, expect, it, vi } from "vitest";
import { XtrapeConnector } from "../src/xtrape-connector";
import type { ConnectorLogRecord, StructuredLogger } from "../src/types";

const baseOptions = {
  backendUrl: "http://localhost:8080",
  tokenStore: { file: "/dev/null" },
  worker: {
    code: "logger-test",
    name: "Logger test",
    version: "0.1.0",
    runtime: "nodejs" as const,
  },
  autoStartLoops: false,
};

describe("structured logger", () => {
  it("falls back to console-shaped logger by default", () => {
    const debug = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const connector = new XtrapeConnector({
      ...baseOptions,
      logger: { debug, info, warn, error },
    });
    // private API exercised via prototype lookup; the public surface goes
    // through `connector.start()` which we don't need here.
    type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, obj?: unknown) => void;
    const log = (connector as unknown as { log: LogFn }).log.bind(connector);
    log("info", "hello");
    log("warn", "with ctx", { agentId: "agt_x" });
    expect(info).toHaveBeenCalledWith("hello");
    expect(warn).toHaveBeenCalledWith("with ctx", { agentId: "agt_x" });
  });

  it("structuredLogger receives normalized ConnectorLogRecord", () => {
    const sink = vi.fn<(record: ConnectorLogRecord) => void>();
    const structured: StructuredLogger = { log: sink };
    const connector = new XtrapeConnector({ ...baseOptions, structuredLogger: structured });
    type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, obj?: unknown) => void;
    const log = (connector as unknown as { log: LogFn }).log.bind(connector);

    log("info", "registered");
    log("warn", "service-report failed", new Error("boom"));
    log("debug", "with primitive", 42);

    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink).toHaveBeenNthCalledWith(1, { level: "info", message: "registered", fields: undefined });
    const second = sink.mock.calls[1][0];
    expect(second.level).toBe("warn");
    expect(second.message).toBe("service-report failed");
    expect(second.fields?.error).toMatchObject({ name: "Error", message: "boom" });
    expect(sink).toHaveBeenNthCalledWith(3, { level: "debug", message: "with primitive", fields: { value: 42 } });
  });

  it("structured logger sees redaction applied to fields", () => {
    const sink = vi.fn<(record: ConnectorLogRecord) => void>();
    const connector = new XtrapeConnector({ ...baseOptions, structuredLogger: { log: sink } });
    type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, obj?: unknown) => void;
    const log = (connector as unknown as { log: LogFn }).log.bind(connector);

    log("warn", "rotation", { tokenStub: "opstage_agent_abcDEF", agentId: "agt_x", count: 1 });
    const record = sink.mock.calls[0][0];
    expect(record.fields).toEqual({
      tokenStub: "[REDACTED]",
      agentId: "agt_x",
      count: 1,
    });
  });
});

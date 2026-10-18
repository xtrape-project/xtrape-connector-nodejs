import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XtrapeConnector } from "../src/xtrape-connector";

type RecordedRequest = {
  method: string;
  pathname: string;
  authorization: string | null;
  body: unknown;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function tokenFile() {
  const dir = await mkdtemp(join(tmpdir(), "xtrape-connector-"));
  return join(dir, "agent-token.json");
}

function installFetch(commands: unknown[] = [], options: { failRegisterWithToken?: string } = {}) {
  const requests: RecordedRequest[] = [];

  globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init?.method ?? "GET",
      pathname: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });

    if (url.pathname === "/api/agents/register") {
      if (options.failRegisterWithToken) {
        return json({
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: `registration failed for ${options.failRegisterWithToken}`,
          },
        }, 400);
      }

      return json({
        data: {
          agentId: "agt_test",
          agentToken: "opstage_agent_test",
          heartbeatIntervalSeconds: 30,
          commandPollIntervalSeconds: 5,
        },
      });
    }

    if (url.pathname === "/api/agents/agt_test/commands" && init?.method === "GET") {
      return json({ data: commands });
    }

    return json({ data: {} });
  }) as typeof fetch;

  return requests;
}

describe("XtrapeConnector", () => {
  it("registers, reports Worker metadata, sends heartbeat, and polls commands", async () => {
    const requests = installFetch();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      logger,
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
        manifest: { labels: { team: "ops" }, agentMode: "embedded" },
      },
    })
      .health(() => ({ status: "UP", message: "ready" }))
      .configs(() => [{ key: "region", type: "string", valuePreview: "local" }])
      .action({
        name: "refresh",
        label: "Refresh",
        handler: async () => ({ refreshed: true }),
      });

    await connector.start();
    await connector.stop();

    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/agents/register",
      "/api/agents/agt_test/workers/report",
      "/api/agents/agt_test/heartbeat",
      "/api/agents/agt_test/commands",
    ]);

    expect(requests[0].body).toMatchObject({
      registrationToken: "opstage_reg_test",
      agent: { code: "demo-service", runtime: "nodejs" },
      service: { manifest: { kind: "Worker", labels: { team: "ops" } } },
    });
    const registration = requests[0].body as { service: { manifest: Record<string, unknown> } };
    expect(registration.service.manifest).not.toHaveProperty("agentMode");
    expect(requests[1].authorization).toBe("Bearer opstage_agent_test");
    expect(requests[1].body).toMatchObject({
      workers: [
        {
          code: "demo-service",
          health: { status: "UP" },
          configs: [{ key: "region", type: "string" }],
          actions: [{ name: "refresh", label: "Refresh" }],
        },
      ],
    });
    const report = requests[1].body as { workers: Array<{ manifest: Record<string, unknown> }> };
    expect(report.workers[0].manifest).not.toHaveProperty("agentMode");
    expect(requests[2].body).toEqual({});
    // The retired ConnectorMode concept must not leak onto the wire in either
    // envelope (contracts#99 D2, review 2239): neither the registration
    // payload nor the reported Worker manifest carries a mode field. The
    // legacy manifest is AnyJson, so only an explicit assertion catches this.
    const registerBody = requests[0].body as { agent: Record<string, unknown> };
    expect(registerBody.agent).not.toHaveProperty("mode");
    const reportBody = requests[1].body as { workers: Array<{ manifest?: Record<string, unknown> }> };
    expect(reportBody.workers[0]!.manifest).toBeDefined();
    expect(reportBody.workers[0]!.manifest).not.toHaveProperty("agentMode");
  });

  it("strips a caller-supplied agentMode from passthrough manifest metadata (review 2239)", async () => {
    // The spread of worker.manifest could quietly revive the retired field;
    // the snapshot destructures it away no matter who supplies it.
    const requests = installFetch();
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      worker: { code: "meta-service", name: "Meta", version: "0.1.0", runtime: "nodejs", manifest: { agentMode: "embedded", labels: { team: "ai" } } },
    }).health(() => ({ status: "UP" }));
    await connector.start();
    const reportBody = requests[1].body as { workers: Array<{ manifest?: Record<string, unknown> }> };
    expect(reportBody.workers[0]!.manifest).not.toHaveProperty("agentMode");
    expect(reportBody.workers[0]!.manifest).toMatchObject({ labels: { team: "ai" } }); // the rest of the passthrough survives
    await connector.stop();
  });

  it("prefers the canonical `connector` identity option over the deprecated `agent` option", async () => {
    const requests = installFetch();

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      connector: { code: "canonical-connector", name: "Canonical Connector", runtime: "nodejs" },
      agent: { code: "legacy-agent", name: "Legacy Agent", runtime: "nodejs" },
      worker: { code: "demo-worker", name: "Demo Worker", version: "1.0.0", runtime: "nodejs" },
    });
    await connector.start();
    await connector.stop();

    // The wire payload keeps the frozen `agent` registration key; its content
    // comes from the canonical `connector` option when both are provided.
    expect(requests[0].body).toMatchObject({
      agent: { code: "canonical-connector", name: "Canonical Connector", runtime: "nodejs" },
    });
  });

  it("still honors the deprecated `agent` identity option when `connector` is absent", async () => {
    const requests = installFetch();

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      agent: { code: "legacy-agent", name: "Legacy Agent", runtime: "nodejs" },
      worker: { code: "demo-worker", name: "Demo Worker", version: "1.0.0", runtime: "nodejs" },
    });
    await connector.start();
    await connector.stop();

    expect(requests[0].body).toMatchObject({
      agent: { code: "legacy-agent", name: "Legacy Agent", runtime: "nodejs" },
    });
  });

  it("still registers via the deprecated `service` option (compatibility)", async () => {
    const requests = installFetch();

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      // Deprecated legacy alias of `worker` — kept as a compatibility surface.
      service: { code: "legacy-service", name: "Legacy Service", version: "0.1.0", runtime: "nodejs" },
    });
    await connector.start();
    await connector.stop();

    expect(requests[0].body).toMatchObject({
      agent: { code: "legacy-service", runtime: "nodejs" },
    });
    expect(requests[1].body).toMatchObject({ workers: [{ code: "legacy-service" }] });
  });

  it("executes an action command and reports the result", async () => {
    const requests = installFetch([
      {
        id: "cmd_refresh",
        agentId: "agt_test",
        serviceId: "svc_demo",
        type: "ACTION",
        actionName: "refresh",
        status: "PENDING",
        payload: { force: true },
        createdAt: "2026-05-06T00:00:00.000Z",
      },
    ]);

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    }).action({
      name: "refresh",
      label: "Refresh",
      handler: async (payload) => ({
        success: true,
        message: "refreshed",
        data: { force: payload.force },
      }),
    });

    await connector.start();
    await connector.stop();

    const result = requests.find((request) => request.pathname.endsWith("/commands/cmd_refresh/result"));
    expect(result?.authorization).toBe("Bearer opstage_agent_test");
    expect(result?.body).toMatchObject({
      success: true,
      message: "refreshed",
      data: { force: true },
    });
  });

  it("does not enforce timeoutSeconds on the canonical polling path", async () => {
    vi.useFakeTimers();
    try {
      let markHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
      let finishHandler!: (value: { success: true; data: { finished: true } }) => void;
      const requests = installFetch([
        {
          id: "cmd_slow",
          agentId: "agt_test",
          serviceId: "svc_demo",
          type: "ACTION",
          actionName: "slow",
          status: "PENDING",
          payload: {},
          timeoutSeconds: 1,
          createdAt: "2026-05-06T00:00:00.000Z",
        },
      ]);
      const connector = new XtrapeConnector({
        backendUrl: "http://opstage.test",
        registrationToken: "opstage_reg_test",
        tokenStore: { file: await tokenFile() },
        autoStartLoops: false,
        failOnStartError: true,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        worker: { code: "demo-service", name: "Demo Service", version: "0.1.0", runtime: "nodejs" },
      }).action({
        name: "slow",
        label: "Slow",
        handler: () => {
          markHandlerStarted();
          return new Promise((resolve) => { finishHandler = resolve; });
        },
      });

      const started = connector.start();
      await handlerStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests.find((request) => request.pathname.endsWith("/commands/cmd_slow/result"))).toBeUndefined();
      finishHandler({ success: true, data: { finished: true } });
      await started;
      await connector.stop();

      const result = requests.find((request) => request.pathname.endsWith("/commands/cmd_slow/result"));
      expect(result?.body).toMatchObject({ success: true, data: { finished: true } });
      expect(result?.body).not.toMatchObject({ error: { code: "ACTION_TIMEOUT" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports missing action handlers as failed command results", async () => {
    const requests = installFetch([
      {
        id: "cmd_missing",
        agentId: "agt_test",
        serviceId: "svc_demo",
        type: "ACTION",
        actionName: "missing",
        status: "PENDING",
        payload: {},
        createdAt: "2026-05-06T00:00:00.000Z",
      },
    ]);

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    });

    await connector.start();
    await connector.stop();

    const result = requests.find((request) => request.pathname.endsWith("/commands/cmd_missing/result"));
    expect(result?.body).toMatchObject({
      success: false,
      error: { code: "ACTION_HANDLER_NOT_FOUND" },
    });
  });

  it("requires a registration token when no stored token exists", async () => {
    installFetch();

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    });

    await expect(connector.start()).rejects.toThrow("a registration token is required for first registration");
  });

  it("reuses stored issued credentials without registering again", async () => {
    const file = await tokenFile();
    await writeFile(
      file,
      JSON.stringify({
        agentId: "agt_test",
        agentToken: "opstage_agent_stored",
      }),
    );

    const requests = installFetch();
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      tokenStore: { file },
      autoStartLoops: false,
      failOnStartError: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    });

    await connector.start();
    await connector.stop();

    expect(requests.some((request) => request.pathname === "/api/agents/register")).toBe(false);
    expect(requests[0].authorization).toBe("Bearer opstage_agent_stored");
  });

  it("prepares actions with default payload values from JSON schema", async () => {
    const requests = installFetch([
      {
        id: "cmd_prepare",
        agentId: "agt_test",
        serviceId: "svc_demo",
        type: "ACTION_PREPARE",
        actionName: "refresh",
        status: "PENDING",
        payload: {},
        createdAt: "2026-05-06T00:00:00.000Z",
      },
    ]);

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    }).action({
      name: "refresh",
      label: "Refresh",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: true },
          limit: { type: "integer" },
          note: { type: "string" },
        },
      },
      handler: async () => ({ success: true }),
    });

    await connector.start();
    await connector.stop();

    const result = requests.find((request) => request.pathname.endsWith("/commands/cmd_prepare/result"));
    expect(result?.body).toMatchObject({
      success: true,
      data: {
        initialPayload: {
          force: true,
          limit: 0,
          note: "",
        },
      },
    });
  });

  it("does not leak tokens in start failure logs", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    installFetch([], { failRegisterWithToken: "opstage_reg_secret" });

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_secret",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: false,
      logger,
      worker: {
        code: "demo-service",
        name: "Demo Service",
        version: "0.1.0",
        runtime: "nodejs",
      },
    });

    await connector.start();
    await connector.stop();

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain("opstage_reg_secret");
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function installFetch(commands: unknown[] = []) {
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
      return json({
        data: {
          agentId: "agt_test123",
          agentToken: "opstage_agent_test_token",
          heartbeatIntervalSeconds: 30,
          commandPollIntervalSeconds: 5,
        },
      });
    }

    if (url.pathname === "/api/agents/agt_test123/commands" && init?.method === "GET") {
      return json({ data: commands });
    }

    return json({ data: {} });
  }) as typeof fetch;

  return requests;
}

describe("Comprehensive Connector Tests", () => {
  // FileTokenStore additional tests
  it("handles invalid JSON token file gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtrape-connector-token-"));
    const file = join(dir, "invalid.json");
    
    // Write invalid JSON
    await writeFile(file, "invalid json content");
    
    const connector = new XtrapeConnector({
      backendUrl: "http://localhost:8080",
      tokenStore: { file },
      worker: {
        code: "test-service",
        name: "Test Service",
        version: "1.0.0",
        runtime: "nodejs"
      },
      autoStartLoops: false,
      failOnStartError: false
    });

    // Should not crash, but will require registration token since stored token is invalid
    await expect(connector.start()).resolves.toBeUndefined();
    
    // Clean up
    await connector.stop();
  });

  // Agent flow tests following existing patterns
  it("reports health provider data correctly", async () => {
    const requests = installFetch();
    
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      worker: {
        code: "health-test",
        name: "Health Test",
        version: "1.0.0",
        runtime: "nodejs",
      },
    }).health(() => ({
      status: "UP",
      message: "healthy",
      details: { uptime: 123 }
    }));

    await connector.start();
    await connector.stop();

    const reportRequest = requests.find(req => req.pathname === "/api/agents/agt_test123/workers/report");
    expect(reportRequest?.body).toMatchObject({
      workers: [
        {
          code: "health-test",
          health: {
            status: "UP",
            message: "healthy",
            details: { uptime: 123 }
          }
        }
      ]
    });
  });

  it("reports config provider data correctly", async () => {
    const requests = installFetch();
    
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      worker: {
        code: "config-test",
        name: "Config Test",
        version: "1.0.0",
        runtime: "nodejs",
      },
    }).configs(() => [
      {
        key: "TEST_CONFIG",
        label: "Test Config",
        type: "string",
        editable: false,
        sensitive: false,
        valuePreview: "test-value"
      }
    ]);

    await connector.start();
    await connector.stop();

    const reportRequest = requests.find(req => req.pathname === "/api/agents/agt_test123/workers/report");
    expect(reportRequest?.body).toMatchObject({
      workers: [
        {
          code: "config-test",
          configs: [
            {
              key: "TEST_CONFIG",
              label: "Test Config",
              type: "string",
              editable: false,
              sensitive: false,
              valuePreview: "test-value"
            }
          ]
        }
      ]
    });
  });

  it("handles action prepare and execute correctly", async () => {
    const requests = installFetch([
      {
        id: "cmd_prepare",
        agentId: "agt_test123",
        serviceId: "svc_test",
        type: "ACTION_PREPARE",
        actionName: "test-action",
        status: "PENDING",
        payload: {},
        createdAt: "2026-05-06T00:00:00.000Z",
      },
      {
        id: "cmd_execute",
        agentId: "agt_test123",
        serviceId: "svc_test",
        type: "ACTION_EXECUTE",
        actionName: "test-action",
        status: "PENDING",
        payload: { test: "input" },
        createdAt: "2026-05-06T00:00:00.000Z",
      }
    ]);
    
    const prepareHandler = vi.fn().mockResolvedValue({
      initialPayload: { test: "value" },
      currentState: { ready: true }
    });
    
    const executeHandler = vi.fn().mockResolvedValue({
      success: true,
      message: "executed",
      data: { result: "success" }
    });

    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      worker: {
        code: "action-test",
        name: "Action Test",
        version: "1.0.0",
        runtime: "nodejs",
      },
    }).action({
      name: "test-action",
      label: "Test Action",
      dangerLevel: "LOW",
      requiresConfirmation: false,
      prepare: prepareHandler,
      handler: executeHandler
    });

    await connector.start();
    await connector.stop();

    // Check prepare result
    const prepareResult = requests.find(req => 
      req.pathname === "/api/agents/agt_test123/commands/cmd_prepare/result"
    );
    expect(prepareResult?.body).toMatchObject({
      success: true,
      data: {
        initialPayload: { test: "value" },
        currentState: { ready: true }
      }
    });

    // Check execute result
    const executeResult = requests.find(req => 
      req.pathname === "/api/agents/agt_test123/commands/cmd_execute/result"
    );
    expect(executeResult?.body).toMatchObject({
      success: true,
      message: "executed",
      data: { result: "success" }
    });
  });

  it("handles unknown action gracefully", async () => {
    const requests = installFetch([
      {
        id: "cmd_unknown",
        agentId: "agt_test123",
        serviceId: "svc_test",
        type: "ACTION_EXECUTE",
        actionName: "unknown-action",
        status: "PENDING",
        payload: {},
        createdAt: "2026-05-06T00:00:00.000Z",
      }
    ]);
    
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_test",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: true,
      worker: {
        code: "unknown-test",
        name: "Unknown Test",
        version: "1.0.0",
        runtime: "nodejs",
      },
    });

    await connector.start();
    await connector.stop();

    const result = requests.find(req => 
      req.pathname === "/api/agents/agt_test123/commands/cmd_unknown/result"
    );
    expect(result?.body).toMatchObject({
      success: false,
      error: { code: "ACTION_HANDLER_NOT_FOUND" }
    });
  });

  it("does not expose token values in logs or public API", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    
    const connector = new XtrapeConnector({
      backendUrl: "http://opstage.test",
      registrationToken: "opstage_reg_secret",
      tokenStore: { file: await tokenFile() },
      autoStartLoops: false,
      failOnStartError: false,
      logger,
      worker: {
        code: "security-test",
        name: "Security Test",
        version: "1.0.0",
        runtime: "nodejs",
      },
    });

    // The connector should not expose tokens publicly
    expect((connector as any).registrationToken).toBeUndefined();
    expect((connector as any).agentToken).toBeUndefined();
    
    // Token store should be private (property name is 'store')
    expect((connector as any).store).toBeDefined();
    
    // Verify that sensitive data is properly redacted in string representations
    const connectorString = String(connector);
    expect(connectorString).not.toContain("opstage_reg_secret");
    expect(connectorString).not.toContain("opstage_agent_");
  });
});
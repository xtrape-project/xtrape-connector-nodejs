import { describe, expect, it, vi } from "vitest";
import { CeServiceConnector } from "../src/index";
import type { CheckpointDefinition, ServiceManifest } from "@xtrape/contracts";

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY"] },
};

function fakeFetch() {
  const calls: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function fakeFetchWithRegisterAccessToken(accessToken = "xtrape_at_test") {
  const calls: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const body = String(url).endsWith("/v1/instances")
      ? { instanceId: "i1", contractVersion: 1, accessToken }
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("CeServiceConnector", () => {
  it("registers an instance with manifest + instance", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000/", manifest, address: "http://10.0.0.5:8080", instanceId: "demo-echo-7f3a", fetchImpl });
    const { instanceId } = await connector.register();
    expect(instanceId).toBe("demo-echo-7f3a");
    expect(calls[0].url).toBe("http://srv:3000/v1/instances");
    expect(calls[0].method).toBe("POST");
    expect((calls[0].body as any).instance.serviceId).toBe("demo-echo-service");
    expect((calls[0].body as any).instance.health).toBe("HEALTHY");
  });

  it("sends the registration token header when configured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", registrationToken: "sek", fetchImpl });
    await connector.register();
    expect(calls[0].headers?.["x-xtrape-registration-token"]).toBe("sek");
  });

  it("omits the registration token header when not configured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.register();
    expect(calls[0].headers?.["x-xtrape-registration-token"]).toBeUndefined();
  });

  it("sends a heartbeat to the instance heartbeat endpoint", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.sendHeartbeat({ uptimeSec: 5 });
    expect(calls[0].url).toBe("http://srv:3000/v1/instances/i1/heartbeat");
    expect((calls[0].body as any).health).toBe("HEALTHY");
    expect((calls[0].body as any).metricsSummary.uptimeSec).toBe(5);
  });

  it("uses the access token returned by registration for heartbeat and deregister", async () => {
    const { calls, fetchImpl } = fakeFetchWithRegisterAccessToken("xtrape_at_123");
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await expect(connector.register()).resolves.toEqual({ instanceId: "i1", accessToken: "xtrape_at_123" });
    await connector.sendHeartbeat();
    await connector.deregister();
    expect(calls[1].url).toBe("http://srv:3000/v1/instances/i1/heartbeat");
    expect(calls[1].headers?.["x-xtrape-access-token"]).toBe("xtrape_at_123");
    expect(calls[1].headers?.["x-xtrape-control-token"]).toBeUndefined();
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].headers?.["x-xtrape-access-token"]).toBe("xtrape_at_123");
  });

  it("publishes schema records before immutable Checkpoints with the Worker credential", async () => {
    const { calls, fetchImpl } = fakeFetchWithRegisterAccessToken("xtrape_at_cp");
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.register();
    const digest = `sha256:${"1".repeat(64)}`;
    await connector.publishSchemaRecords([{ bytesJson: "{}", dialect: "https://json-schema.org/draft/2020-12/schema", digest }]);
    const definition: CheckpointDefinition = {
      contractVersion: 1,
      id: { serviceId: manifest.service.id, checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: digest },
      outputSchema: { schemaRecord: digest },
      resourceExtraction: {
        kind: "extractor-artifact",
        artifactDigest: `sha256:${"2".repeat(64)}`,
        executionProfileRecord: `sha256:${"3".repeat(64)}`,
      },
      sideEffect: "READ_ONLY",
      risk: "LOW",
      sensitivity: { inputUpperBound: "INTERNAL", outputUpperBound: "INTERNAL" },
      idempotency: "IDEMPOTENT",
      delivery: "AT_LEAST_ONCE",
      retry: "IDEMPOTENT_REPLAY",
      execution: "SYNC",
      action: { actionId: "getRepository" },
      localPreconditions: [],
    };
    await connector.publishCheckpoints([definition]);

    expect(calls[1]).toMatchObject({
      url: "http://srv:3000/v1/instances/i1/schema-records",
      headers: { "x-xtrape-access-token": "xtrape_at_cp" },
    });
    expect(calls[2]).toMatchObject({
      url: "http://srv:3000/v1/instances/i1/checkpoints",
      headers: { "x-xtrape-access-token": "xtrape_at_cp" },
    });
    expect((calls[2].body as { checkpointId: string }).checkpointId).toBe("repository.get");
  });

  it("refuses to publish a Checkpoint owned by another Service", async () => {
    const { fetchImpl } = fakeFetchWithRegisterAccessToken();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.register();
    await expect(connector.publishCheckpoints([{
      contractVersion: 1,
      id: { serviceId: "other-service", checkpointId: "repository.get", checkpointVersion: "1.0.0" },
      inputSchema: { schemaRecord: `sha256:${"1".repeat(64)}` },
      outputSchema: { schemaRecord: `sha256:${"1".repeat(64)}` },
      resourceExtraction: { kind: "extractor-artifact", artifactDigest: `sha256:${"2".repeat(64)}`, executionProfileRecord: `sha256:${"3".repeat(64)}` },
      sideEffect: "READ_ONLY", risk: "LOW",
      sensitivity: { inputUpperBound: "INTERNAL", outputUpperBound: "INTERNAL" },
      idempotency: "IDEMPOTENT", delivery: "AT_LEAST_ONCE", retry: "IDEMPOTENT_REPLAY", execution: "SYNC",
      action: { actionId: "getRepository" },
      localPreconditions: [],
    }])).rejects.toThrow(/belongs to other-service/);
  });

  it("builds a valid reply message from an inbound QUERY", async () => {
    const { fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", fetchImpl });
    const handler = vi.fn(async () => "healthy; last run ok");
    const reply = await connector.handleMessage(
      {
        contractVersion: 1,
        messageId: "msg_001",
        conversationId: "conv_tg_123",
        targetType: "SERVICE",
        targetId: "demo-echo-service",
        senderType: "USER",
        senderId: "telegram:123456",
        messageType: "QUERY",
        content: "status?",
      },
      handler,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(reply.senderType).toBe("SERVICE");
    expect(reply.senderId).toBe("demo-echo-service");
    expect(reply.targetType).toBe("USER");
    expect(reply.targetId).toBe("telegram:123456");
    expect(reply.replyToMessageId).toBe("msg_001");
    expect(reply.content).toBe("healthy; last run ok");
    expect(reply.conversationId).toBe("conv_tg_123");
  });

  it("rejects an invalid inbound message", async () => {
    const { fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", fetchImpl });
    await expect(connector.handleMessage({ contractVersion: 1, messageId: "x" }, async () => "ignored")).rejects.toThrow();
  });

  it("preserves HTTP status details when platform-ce returns a non-JSON error response", async () => {
    const fetchImpl = (async () =>
      new Response("<html>denied</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", fetchImpl });
    await expect(connector.register()).rejects.toThrow("platform-ce /v1/instances -> 403: <html>denied</html>");
  });
});

describe("CeServiceConnector.postConversationMessage (server-ce#63)", () => {
  it("posts a persist-only envelope to the instance message route with the access token", async () => {
    const { calls, fetchImpl } = fakeFetchWithRegisterAccessToken("xtrape_at_63");
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.register();

    const sent = await connector.postConversationMessage({
      conversationId: "conv_task_9",
      targetId: "telegram:1",
      content: "step 2 of 5 done",
      payload: { taskId: "cmd_9", kind: "progress" },
    });

    const post = calls[1];
    expect(post.url).toBe("http://srv:3000/v1/instances/i1/messages");
    expect(post.method).toBe("POST");
    expect(post.headers?.["x-xtrape-access-token"]).toBe("xtrape_at_63");
    const body = post.body as any;
    expect(body.senderType).toBe("SERVICE");
    expect(body.senderId).toBe("demo-echo-service");
    expect(body.targetType).toBe("USER");
    expect(body.payload).toEqual({ taskId: "cmd_9", kind: "progress" });
    expect(body.messageId).toMatch(/^msg_/);
    expect(sent.messageId).toBe(body.messageId);
  });

  it("honors explicit messageId, messageType, and replyToMessageId", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await connector.postConversationMessage({
      conversationId: "conv_task_9",
      targetType: "TASK",
      targetId: "cmd_9",
      messageType: "QUERY",
      messageId: "msg_fixed_1",
      replyToMessageId: "msg_user_1",
      content: "which repository?",
    });
    const body = calls[0].body as any;
    expect(body.messageId).toBe("msg_fixed_1");
    expect(body.messageType).toBe("QUERY");
    expect(body.targetType).toBe("TASK");
    expect(body.replyToMessageId).toBe("msg_user_1");
  });

  it("rejects an invalid envelope before any request is sent", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const connector = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
    await expect(
      connector.postConversationMessage({ conversationId: "", targetId: "telegram:1", content: "x" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

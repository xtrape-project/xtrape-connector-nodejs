import { describe, expect, it } from "vitest";
import type { ServiceManifest } from "@xtrape/contracts";
import { CeServiceConnector } from "../src/ce";

const manifest: ServiceManifest = {
  contractVersion: 1,
  tenant: "default",
  service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.1.0" },
  runtime: { language: "node", agent: "@xtrape/connector" },
  capabilities: ["status.query"],
  message: { supportedTypes: ["QUERY", "APPROVAL_REQUEST", "APPROVAL_RESPONSE"] },
};

function fakeFetch() {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function connector() {
  const { calls, fetchImpl } = fakeFetch();
  const c = new CeServiceConnector({ serverUrl: "http://srv:3000", manifest, address: "http://10.0.0.5:8080", instanceId: "i1", fetchImpl });
  // The messageId of the last APPROVAL_REQUEST this connector posted — what a
  // real answering surface (Panel/Telegram) echoes back as replyToMessageId.
  const lastQuestionId = (): string => {
    const posted = [...calls].reverse().find(
      (x) => x.url.includes("/messages") && (x.body as Record<string, unknown> | undefined)?.["messageType"] === "APPROVAL_REQUEST",
    );
    return (posted!.body as Record<string, string>)["messageId"];
  };
  return { calls, connector: c, lastQuestionId };
}

/**
 * A person's answer as it arrives on the ordinary inbound path. `replyTo`
 * threads it to the question — the job of the surface that rendered the
 * APPROVAL_REQUEST, never the person's to type.
 */
const answer = (conversationId: string, replyTo: string, over: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  messageId: "msg_answer1",
  conversationId,
  tenant: "default",
  targetType: "SERVICE",
  targetId: "demo-echo-service",
  senderType: "USER",
  senderId: "operator:ada",
  messageType: "APPROVAL_RESPONSE",
  content: "yes",
  payload: { granted: true },
  replyToMessageId: replyTo,
  ...over,
});

describe("ask(): the interaction primitive (xtrape-docs#241)", () => {
  it("posts the canonical approval shape and resolves on the threaded answer", async () => {
    const { calls, connector: c, lastQuestionId } = connector();
    const pending = c.ask({ conversationId: "apr_cmd1", content: "Run db.drop on db-prod-01?", payload: { commandId: "cmd1" } });

    const posted = calls.find((x) => x.url.includes("/messages"))!.body as Record<string, unknown>;
    expect(posted["messageType"]).toBe("APPROVAL_REQUEST");
    expect(posted["targetType"]).toBe("SYSTEM");
    expect(posted["conversationId"]).toBe("apr_cmd1");
    expect((posted["payload"] as Record<string, unknown>)["commandId"]).toBe("cmd1");

    const reply = await c.handleMessage(answer("apr_cmd1", lastQuestionId()), () => "unused");
    const got = await pending;
    expect((got.payload as Record<string, unknown>).granted).toBe(true);
    expect(got.senderId).toBe("operator:ada");
    expect(reply.messageType).toBe("SUMMARY");
    expect(reply.replyToMessageId).toBe("msg_answer1");
  });

  it("ignores an untethered answer — a late reply to an aborted question cannot resolve a new one", async () => {
    const { connector: c, lastQuestionId } = connector();
    const pending = c.ask({ conversationId: "apr_cmd2", content: "?" });
    // No replyToMessageId: the connector cannot tell this from a stale answer
    // to an earlier question on a reused conversation, so it must not resolve.
    let handlerSaw = 0;
    await c.handleMessage(answer("apr_cmd2", "", { replyToMessageId: undefined }), () => {
      handlerSaw += 1;
      return "handled";
    });
    // Still pending; the properly threaded answer resolves it.
    await c.handleMessage(answer("apr_cmd2", lastQuestionId()), () => "unused");
    await pending;
    // The untethered one fell through to the general handler, unclaimed.
    expect(handlerSaw).toBe(1);
  });

  it("does not hand a threaded answer to the general handler", async () => {
    const { connector: c, lastQuestionId } = connector();
    const pending = c.ask({ conversationId: "apr_cmd3", content: "?" });
    let handlerSaw = 0;
    await c.handleMessage(answer("apr_cmd3", lastQuestionId()), () => {
      handlerSaw += 1;
      return "nope";
    });
    await pending;
    expect(handlerSaw).toBe(0);
  });

  it("leaves an answer for a different conversation to the general handler", async () => {
    const { connector: c, lastQuestionId } = connector();
    const pending = c.ask({ conversationId: "apr_cmd4", content: "?" });
    let handlerSaw = 0;
    await c.handleMessage(answer("conv_other", "msg_whatever"), () => {
      handlerSaw += 1;
      return "handled";
    });
    expect(handlerSaw).toBe(1);
    await c.handleMessage(answer("apr_cmd4", lastQuestionId()), () => "unused");
    await pending;
  });

  it("refuses a second question on a conversation someone is already answering", async () => {
    const { connector: c, lastQuestionId } = connector();
    const pending = c.ask({ conversationId: "apr_cmd5", content: "?" });
    await expect(c.ask({ conversationId: "apr_cmd5", content: "again?" })).rejects.toThrow(/already pending/);
    await c.handleMessage(answer("apr_cmd5", lastQuestionId()), () => "unused");
    await pending;
  });

  it("ends the wait when the command is cancelled, and frees the conversation", async () => {
    const { connector: c, lastQuestionId } = connector();
    const controller = new AbortController();
    const pending = c.ask({ conversationId: "apr_cmd6", content: "?", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    // Free again — a re-run may ask afresh, and its own threaded answer resolves.
    const again = c.ask({ conversationId: "apr_cmd6", content: "?" });
    await c.handleMessage(answer("apr_cmd6", lastQuestionId()), () => "unused");
    await again;
  });

  it("refuses to ask at all when the command is already cancelled — no orphan question", async () => {
    const { calls, connector: c } = connector();
    const controller = new AbortController();
    controller.abort();
    await expect(c.ask({ conversationId: "apr_cmd7", content: "?", signal: controller.signal })).rejects.toThrow(/already cancelled/);
    // Nothing was posted: an orphan question in front of a person is the thing
    // this prevents.
    expect(calls.some((x) => x.url.includes("/messages"))).toBe(false);
  });
});

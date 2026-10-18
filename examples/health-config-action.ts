/**
 * A Worker that demonstrates the three main developer surfaces:
 *   - .health()  — report operator-facing health
 *   - .configs() — report typed config items, including secret-bearing ones
 *   - .action()  — expose an operator-callable operation with input validation
 *
 * Run with:
 *   XTRAPE_SERVER_URL=http://localhost:8080 \
 *   XTRAPE_REGISTRATION_TOKEN=xtrape_reg_... \
 *   UPSTREAM_URL=https://example.com \
 *   npx tsx examples/health-config-action.ts
 */
import { XtrapeConnector } from "@xtrape/connector";

const connector = new XtrapeConnector({
  backendUrl: process.env.XTRAPE_SERVER_URL ?? "http://localhost:8080",
  registrationToken: process.env.XTRAPE_REGISTRATION_TOKEN,
  tokenStore: { file: "./data/hca-agent-token.txt" },
  worker: {
    code: "hca-example",
    name: "Health/Config/Action example",
    version: "0.6.0-example", // Worker version (this is the example Worker, not the SDK)
    runtime: "nodejs",
  },
});

// Health — sampled for each Worker Runtime Report. Keep it cheap.
connector.health(async () => {
  try {
    const url = process.env.UPSTREAM_URL;
    if (!url) return { status: "UNKNOWN", message: "UPSTREAM_URL is not set" };
    const res = await fetch(url, { method: "HEAD" });
    return res.ok
      ? { status: "UP", details: { httpStatus: res.status } }
      : { status: "DEGRADED", message: `upstream returned ${res.status}` };
  } catch (err) {
    return { status: "DOWN", message: String(err) };
  }
});

// Configs — typed entries. Mark secret-bearing keys with sensitive=true and
// emit a placeholder valuePreview, never the real value.
connector.configs(() => [
  {
    key: "UPSTREAM_URL",
    type: "string",
    sensitive: false,
    editable: false,
    valuePreview: process.env.UPSTREAM_URL,
  },
  {
    key: "UPSTREAM_API_KEY",
    type: "secret",
    sensitive: true,
    editable: false,
    valuePreview: "[REDACTED]",
    secretRef: "env://UPSTREAM_API_KEY",
  },
]);

// One operator action with input validation. Returning success=false hands
// the error back to the operator in the command result; throwing also works
// and is caught by the SDK.
connector.action({
  name: "echo",
  label: "Echo",
  description: "Return the submitted message back to the operator.",
  dangerLevel: "LOW",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string", default: "hello" } },
  },
  handler: async (payload) => ({
    success: true,
    data: { echo: payload.message, receivedAt: new Date().toISOString() },
  }),
});

await connector.start();
console.log("Health/Config/Action example started. Press Ctrl-C to stop.");

const stop = async () => {
  await connector.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

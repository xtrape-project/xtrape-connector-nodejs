/**
 * The smallest viable Worker.
 *
 * Verifies that:
 *   - the SDK can register with the control plane (xtrape-platform-ce)
 *   - the registration token is exchanged for an agent token
 *   - the agent-token file store is written on first start
 *   - heartbeats begin
 *
 * Run with:
 *   XTRAPE_SERVER_URL=http://localhost:8080 \
 *   XTRAPE_REGISTRATION_TOKEN=xtrape_reg_... \
 *   npx tsx examples/minimal-connector.ts
 */
import { XtrapeConnector } from "@xtrape/connector";

const connector = new XtrapeConnector({
  backendUrl: process.env.XTRAPE_SERVER_URL ?? "http://localhost:8080",
  registrationToken: process.env.XTRAPE_REGISTRATION_TOKEN,
  tokenStore: { file: process.env.XTRAPE_TOKEN_FILE ?? "./data/minimal-connector-token.txt" },
  worker: {
    code: "minimal-example",
    name: "Minimal example",
    version: "0.6.0-example", // Worker version (this is the example Worker, not the SDK)
    runtime: "nodejs",
    description: "Smallest viable Worker — registration + heartbeat only.",
  },
});

await connector.start();
console.log("Minimal Worker started. Press Ctrl-C to stop.");

const stop = async () => {
  await connector.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

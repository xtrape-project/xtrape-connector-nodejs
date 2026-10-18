/**
 * Demonstrates the two-phase ACTION_PREPARE → ACTION_EXECUTE lifecycle by
 * registering an action with a `prepare` handler. When the operator opens
 * the action panel in the Panel console, the control plane dispatches an
 * ACTION_PREPARE command. The SDK calls `prepare()` and returns dynamic
 * form metadata (initialPayload + currentState) without ever running the
 * destructive handler.
 *
 * Use this pattern when the action panel needs values that aren't known
 * until the action is opened — e.g. a fresh list of accounts, the current
 * upstream URL, or a server-generated default key.
 *
 * Run with:
 *   XTRAPE_SERVER_URL=http://localhost:8080 \
 *   XTRAPE_REGISTRATION_TOKEN=xtrape_reg_... \
 *   npx tsx examples/prepare-handler.ts
 */
import { XtrapeConnector } from "@xtrape/connector";

let currentGreeting = "hello";

const connector = new XtrapeConnector({
  backendUrl: process.env.XTRAPE_SERVER_URL ?? "http://localhost:8080",
  registrationToken: process.env.XTRAPE_REGISTRATION_TOKEN,
  tokenStore: { file: "./data/prepare-agent-token.txt" },
  worker: {
    code: "prepare-example",
    name: "Prepare handler example",
    version: "0.6.0-example", // Worker version (this is the example Worker, not the SDK)
    runtime: "nodejs",
  },
});

connector.action({
  name: "setGreeting",
  label: "Set greeting",
  description: "Update the current greeting message.",
  dangerLevel: "LOW",
  requiresConfirmation: true,
  inputSchema: {
    type: "object",
    required: ["greeting"],
    properties: { greeting: { type: "string", minLength: 1 } },
  },
  // Runs at panel-open time. Surfaces the *current* greeting back to the UI
  // so the operator can see what they're editing.
  prepare: () => ({
    initialPayload: { greeting: currentGreeting },
    currentState: { greeting: currentGreeting, lastChangedAt: new Date().toISOString() },
  }),
  // Runs when the operator submits the form.
  handler: async (payload) => {
    const next = (payload.greeting as string).trim();
    if (!next) {
      return {
        success: false,
        error: { code: "GREETING_EMPTY", message: "greeting must not be empty" },
      };
    }
    const previous = currentGreeting;
    currentGreeting = next;
    return { success: true, data: { previous, current: currentGreeting } };
  },
});

await connector.start();
console.log("Prepare handler example started. Press Ctrl-C to stop.");

const stop = async () => {
  await connector.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

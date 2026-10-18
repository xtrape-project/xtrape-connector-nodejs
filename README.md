# Xtrape Connector SDK for Node.js

> Node.js Connector SDK for connecting Workers to the Xtrape control plane.

`@xtrape/connector` is the canonical package name and `XtrapeConnector` the
canonical entry class (formerly `@xtrape/agent` / `XtrapeAgent`; renamed per
the 0.8.0 concept freeze, agent-nodejs#75). `XtrapeAgent` and
`XtrapeAgentOptions` remain exported as `@deprecated` compatibility aliases so
existing integrations migrate gradually; new integrations use
`XtrapeConnector` and the `worker` option.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)(./LICENSE)
![Status: 0.8.x](https://img.shields.io/badge/status-0.8.x-blue.svg)
![Docs](https://img.shields.io/badge/docs-xtrape--docs-blue.svg)

The package supports the Node.js Embedded Connector mode (formerly Embedded
Agent mode) for one Worker. Multi-Worker ownership belongs to a sidecar or
external Connector (formerly sidecar/external Agent). (`Gateway` is a retired top-level concept per the 0.8.0 object model; control-plane routing belongs to Platform modules.)

> **Package status:** This package follows Xtrape milestone-aligned component
> versioning (`MINOR` = milestone). The current milestone line is `0.8.x`.

## Install

```bash
pnpm add @xtrape/connector@^0.8.0
```

For this repository itself:

```bash
pnpm install
pnpm build
```

## Xtrape CE Phase 0 Service Connector

For the Xtrape CE 0.1 runtime loop (`Telegram → xtrape-platform-ce → xtrape-service
→ reply`), use `CeServiceConnector` (formerly `CeServiceAgent`, which remains
exported as a `@deprecated` alias) or the `serveCeService` bootstrap. An
`xtrape-service` registers an instance to `xtrape-platform-ce`, heartbeats, and
replies to `ConversationMessage`s. `Service` and `Worker` are roles here, not the
legacy `Capsule` concept.

### One-call bootstrap

`serveCeService` starts an HTTP listener (`POST /messages`, action endpoints,
`GET /health`),
registers the instance (sending the registration token if platform-ce requires
one), stores the per-instance access token returned by platform-ce, and runs
authenticated heartbeats — so a service does not copy-paste lifecycle code:

For deployed or containerized use, set `address` to the callback URL that
`xtrape-platform-ce` can actually reach and allowlist, for example
`http://demo-service:8080`. The SDK only derives a default address when you
bind to an explicit local-only host such as `127.0.0.1`.

```ts
import { serveCeService } from "@xtrape/connector";

const svc = await serveCeService({
  serverUrl: process.env.XTRAPE_SERVER_URL ?? "http://localhost:3000",
  // Env prefix: PLATFORM_CE_* is canonical on the control plane
  // (server-ce#145); the SERVER_CE_* spellings below are still accepted as
  // deprecated compatibility aliases, so they are kept verbatim here.
  registrationToken: process.env.SERVER_CE_REGISTRATION_TOKEN,
  // Optional compatibility fallback for older platform-ce deployments. Current
  // platform-ce returns a per-instance access token during registration, and the
  // SDK uses that token first for heartbeat/deregister.
  controlToken: process.env.SERVER_CE_CONTROL_TOKEN,
  // Optional: require authenticated callbacks from platform-ce on POST /messages
  // and action endpoints (x-xtrape-service-callback-token or Authorization: Bearer).
  callbackToken: process.env.SERVICE_CALLBACK_TOKEN,
  port: 8080,
  // required in deployed/containerized environments
  address: process.env.SERVICE_ADDRESS ?? "http://demo-service:8080",
  manifest: {
    contractVersion: 1,
    service: { id: "demo-echo-service", name: "Demo Echo Service", version: "0.7.0" },
    // `agent` is a frozen telemetry key; its value points at the Connector SDK.
    runtime: { language: "node", agent: "@xtrape/connector" },
    capabilities: ["status.query"],
    message: { supportedTypes: ["QUERY"] },
  },
  handler: (msg) => `echo: ${msg.content}`,
});

process.on("SIGTERM", () => void svc.close()); // stop heartbeat + deregister + close
```

### CE service actions

Pass `actions` to expose operator-triggerable operations over `GET /actions`,
`POST /actions/:name/prepare`, and `POST /actions/:name/execute`:

```ts
const svc = await serveCeService({
  // ...as above
  actions: [
    {
      name: "relogin",
      label: "Re-login account",
      // Optional two-phase prepare: fetch live defaults/current state before
      // the operator fills the form (advertised as requiresPrepare: true).
      prepare: async () => ({ initialPayload: { accountId: "acc-1" } }),
      execute: async (input) => ({ ok: true }),
    },
    {
      name: "full-sync",
      label: "Full re-sync",
      // Long-running action (server-ce#41 Stage B): when the pushed execute
      // carries x-xtrape-command-id, the SDK replies 202 RUNNING immediately,
      // runs execute in the background, and reports the outcome to platform-ce
      // with the per-instance access token. Against an older platform-ce
      // (no header) the action falls back to synchronous execution.
      async: true,
      execute: async (input) => runFullSync(input),
    },
  ],
});
```

### Governed Action publication

An Action catalog is implementation metadata, not execution authority. A
governed Service publishes the content-addressed JSON Schemas and immutable
Checkpoints that authorize its Actions, and binds every Action one-to-one to an
exact Checkpoint version:

```ts
await serveCeService({
  // ...listener, manifest, registration and message options...
  schemaRecords: [{
    bytesJson: inputSchemaBytes,
    dialect: "https://json-schema.org/draft/2020-12/schema",
    digest: inputSchemaDigest,
  }],
  checkpoints: [repositoryGetCheckpoint],
  actions: [{
    name: "getRepository",
    label: "Get repository",
    checkpoint: repositoryGetCheckpoint.id,
    inputSchema: JSON.parse(inputSchemaBytes),
    execute: getRepository,
  }],
});
```

World A submits the complete descriptor through one authenticated Platform
admission route before it begins serving work. World B never dials Platform;
the operator-side provisioning flow reads the same data atomically from
authenticated `GET /descriptor`. A legacy Service with no Checkpoints returns
`404 AUTHORITY_DESCRIPTOR_NOT_AVAILABLE`, allowing Platform to use the legacy
`/actions` compatibility path; any present but invalid descriptor remains a
hard failure and must not downgrade. The SDK snapshots every authority-bearing
object at startup, so later caller mutation cannot change the admitted binding.
If World A admission fails, the just-registered Worker incarnation is
deregistered before startup returns the error. The SDK refuses to start when
the descriptor is incomplete or ambiguous, so neither transport can advertise
an ungoverned Action. Although World A binds the callback socket before
registration (required to report an ephemeral port), messages and Action
catalog/prepare/execute/cancel endpoints return `503 NOT_READY` until
registration and governed admission are complete. World B keeps its
authenticated `/descriptor` available for the provisioning probe.

### Lower-level connector

When the service already runs its own HTTP server, use `CeServiceConnector` directly:

```ts
import { CeServiceConnector } from "@xtrape/connector";

const connector = new CeServiceConnector({
  serverUrl: "http://localhost:3000",
  registrationToken: process.env.SERVER_CE_REGISTRATION_TOKEN,
  controlToken: process.env.SERVER_CE_CONTROL_TOKEN, // compatibility fallback only
  address: "http://127.0.0.1:8080",
  manifest: /* ServiceManifest */ undefined as never,
});

const stop = await connector.start();      // register + heartbeat
// in your POST /messages route:
const reply = await connector.handleMessage(requestJson, (m) => `echo: ${m.content}`);
// on shutdown:
await stop();                              // stop heartbeat + deregister
```

## Minimal Example

This example uses the canonical `XtrapeConnector` class, configures
providers with `.health()` / `.configs()`, register Actions with `.action()`,
then call `start()`.

```ts
import { XtrapeConnector } from "@xtrape/connector";

const connector = new XtrapeConnector({
  backendUrl: process.env.XTRAPE_SERVER_URL ?? "http://localhost:8080",
  registrationToken: process.env.XTRAPE_REGISTRATION_TOKEN,
  tokenStore: { file: "./data/agent-token.txt" },
  // Optional. If omitted, the SDK derives the Connector identity from
  // `worker`. Provide it explicitly when one Connector owns multiple
  // Workers on the same host, or when you want a stable code that survives
  // service renames. (`agent` is the deprecated former name of this option;
  // if both are set, `connector` wins.)
  connector: {
    code: "hello-worker-connector",
    name: "Hello Worker Connector",
    runtime: "nodejs",
  },
  worker: {
    code: "hello-worker",
    name: "Hello Worker",
    version: "0.1.0",
    runtime: "nodejs",
    description: "Minimal Worker example",
  },
});

connector.health(() => ({
  status: "UP",
  message: "ok",
  details: {
    uptimeSeconds: Math.floor(process.uptime()),
  },
}));

connector.configs(() => [
  {
    key: "HELLO_MODE",
    label: "Hello mode",
    type: "string",
    editable: false,
    sensitive: false,
    valuePreview: process.env.HELLO_MODE ?? "default",
  },
]);

connector.action({
  name: "echo",
  label: "Echo",
  description: "Return the submitted message.",
  dangerLevel: "LOW",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", default: "hello" },
    },
  },
  prepare: () => ({
    initialPayload: { message: "hello" },
    currentState: { service: "ready" },
  }),
  handler: async (payload) => ({
    success: true,
    data: { echo: payload.message },
  }),
});

await connector.start();
```

## How Registration Works

1. An operator creates a single-use registration credential in Panel CE (the
   current API calls it a Registration Token).
2. The Worker starts with `registrationToken` and calls the Connector
   registration API (the wire route is still `/api/agents/register`).
3. The control plane returns a Connector ID and Connector credential (the
   current API names these `agentId` and Agent token).
4. The SDK stores the issued credentials in `tokenStore.file` as `<agentId>:<agentToken>`.
5. Future restarts reuse the stored Agent token; the Registration Token is not
   needed again.

If the token file is lost or the Connector is revoked, create a new
Registration Token and restart the service with it.

## Worker Manifest

The `worker` option describes the Worker reported to the control plane. The old
`service` option remains accepted for compatibility:

```ts
worker: {
  code: "hello-worker",           // stable unique Worker code
  name: "Hello Worker",           // operator-facing display name
  description: "...",            // optional
  version: "0.1.0",              // service version
  runtime: "nodejs",             // nodejs | java | python | go | other
  manifest: { labels: { team: "ai" } }, // optional passthrough metadata
}
```

The SDK wraps this as a Worker manifest with `kind: "Worker"` and
`schemaVersion: "1.0"`. The retired `agentMode` field is never emitted, even
when it is present in legacy passthrough metadata. Existing control-plane
versions continue accepting the manifest through the legacy reported-service
wire envelope.

## Health Reporting

Use `.health(provider)` to report protocol-level health:

```ts
connector.health(async () => ({
  status: "UP", // UP | DEGRADED | DOWN | UNKNOWN
  message: "queue healthy",
  details: { queueDepth: 0 },
}));
```

The provider runs for heartbeats and Worker Runtime Reports. Do not include secrets in
`details`.

Connector health providers return protocol-level `HealthStatus` values: `UP`,
`DEGRADED`, `DOWN`, `UNKNOWN`.

Xtrape Panel may derive an operator-facing `effectiveStatus`: `HEALTHY`, `UNHEALTHY`,
`STALE`, `OFFLINE`.

## Config Reporting

Use `.configs(provider)` to report observed config metadata:

```ts
connector.configs(() => [
  {
    key: "UPSTREAM_BASE_URL",
    type: "string",
    sensitive: false,
    editable: false,
    valuePreview: process.env.UPSTREAM_BASE_URL,
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
```

Config Definitions and safe observations are reported to the control plane and
surfaced in Panel for operator visibility.
The Worker or deployment platform remains the configuration owner; current CE
does not push arbitrary values into the Worker.

## Actions

Use `.action()` to expose an operator-triggerable operation:

```ts
connector.action({
  name: "reload-cache",
  label: "Reload Cache",
  dangerLevel: "MEDIUM",
  requiresConfirmation: true,
  timeoutSeconds: 30,
  handler: async () => {
    await reloadCache();
    return { success: true, message: "Cache reloaded." };
  },
});
```

Action metadata is published in the Worker Runtime Report. The SDK intentionally strips
runtime-only handler functions before reporting the Action Catalog.

## Action Prepare / Execute

The Xtrape control plane uses two Command types for actions:

1. `ACTION_PREPARE` — created when the UI opens an Action panel. The SDK calls
   `prepare()` if present and returns dynamic form metadata such as
   `inputSchema`, `initialPayload`, and `currentState`.
2. `ACTION_EXECUTE` — created when the operator confirms the Action. The SDK
   calls `handler(payload)` and reports the result.

If an Action has no `prepare` handler, the SDK returns a default prepare payload
based on the action metadata and `inputSchema` defaults.

### The REVIEW step of a two-phase Checkpoint (runtime-platform/13)

A governed two-phase Checkpoint has one immutable definition with two faces:
the review face (`definition.review`, authored with `reviewFaceFor(definition, {...})`,
which defaults `risk` to the execution risk and `affinity` to `INCARNATION`)
and the execution face. The Platform runs them as two Commands:

1. `REVIEW` — read-only. World A delivers it as a `DeliveredCommand` with
   `operation: "REVIEW"`; `CeLongPollHandlers.onReview` is **required** (a
   loop never acks a review it cannot answer). `serveCeService` answers it
   from `action.review(input, context)` — or, for an action that only has
   `prepare`, from `prepare()` (13 §9 alias) — as
   `{ next: { inputSchema, initialPayload, currentState } }`, on the report
   path. World B dials `POST /actions/:name/review` under `x-xtrape-command-id`
   (required — a review is a Command) with the same lifecycle as execute: a
   CANCEL that arrived first wins (`409 CANCELLED`), a CANCEL during the
   handler discards the late result, and a retry of the same command id
   recovers the same frozen `next` (13 §5.5) for as long as the command is
   remembered.
2. `EXECUTE` — a new Command, dispatched only after the Platform admitted
   the review; the action verifies the review binding it sealed.

`context.filterResources(candidates)` (`CeReviewContext`; also present on
`CePrepareContext` when `prepare` answers as the alias) is the 13 §4.3
candidate exchange: submit the target identifiers you would offer and build
the narrowed enum from the admitted subset that comes back. It needs the
per-instance lifecycle credential, so a listen-only (never registered)
instance does not advertise `features.review` (`REVIEW_FEATURE`).

```ts
{
  name: "reboot",
  label: "Reboot server",
  checkpoint: rebootCheckpoint.id,
  review: async (_input, ctx) => {
    const servers = await ctx.filterResources(await listServerIds());
    return {
      inputSchema: { type: "object", required: ["server"], additionalProperties: false,
        properties: { server: { type: "string", enum: servers } } },
      initialPayload: { server: servers[0] },
      currentState: {},
    };
  },
  execute: (input) => reboot(input.server),
}
```

## Command Polling

The embedded Connector starts three loops by default:

| Loop           |    Default | Purpose                            |
| -------------- | ---------: | ---------------------------------- |
| Heartbeat      | 30 seconds | Connector liveness                 |
| Worker report  | 60 seconds | Manifest, config observations, Actions, health |
| Command poll   |  5 seconds | Fetch and execute pending Commands |

You can override intervals:

```ts
new XtrapeConnector({
  // ...
  intervals: {
    heartbeatMs: 30_000,
    workerReportMs: 60_000,
    commandPollMs: 5_000,
  },
});
```

For tests, set `autoStartLoops: false` and call `start()` to perform one
registration/report/heartbeat/poll cycle.

## Token Storage

The default token store is file-based via `FileTokenStore`. Store the token file
in a private data directory:

```ts
new XtrapeConnector({
  // ...
  tokenStore: { file: "./data/agent-token.txt" },
});
```

Security recommendations:

- chmod the containing directory so only the service user can read it;
- never commit token files;
- rotate by revoking the Connector in Xtrape Panel and registering a new one;
- prefer secret managers for production wrappers when available.

## Security Notes

- Registration Tokens are single-use bootstrap credentials.
- Agent Tokens are long-lived bearer tokens; treat them as secrets.
- Actions are remote operational capabilities. Use `dangerLevel`,
  `requiresConfirmation`, and server-side validation in handlers.
- Do not report raw passwords, API keys, cookies, OTPs, browser storage, or
  session files through health/config/action results.
- Logs are redacted by the SDK where possible, but service handlers remain
  responsible for avoiding secret leakage.

## API Reference

Main exports:

- `XtrapeConnector` (`XtrapeAgent` remains as a `@deprecated` alias)
- `FileTokenStore`
- `ConnectorApiClient` (`AgentApiClient` remains as a `@deprecated` alias)
- `ConnectorApiError`, `RegistrationError`, `ConnectorAuthError`, `NetworkError`
  (`AgentApiError` / `AgentAuthError` remain as `@deprecated` aliases of the
  same classes — `instanceof` keeps working)
- `ConnectorLogLevel`, `ConnectorLogRecord`, `StructuredLogger`, `ConsoleLogger`
  (types; `AgentLogLevel` / `AgentLogRecord` are `@deprecated` aliases)
- SDK option and provider types from `types.ts`

Core methods:

| Method                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `new XtrapeConnector(options)`  | Creates the embedded Connector.                               |
| `.health(provider)`         | Registers a health provider.                                  |
| `.configs(provider)`        | Registers a config provider.                                  |
| `.action(action)`           | Registers an operator Action.                                 |
| `.start()`                  | Registers if needed, reports service state, and starts loops. |
| `.stop()`                   | Stops background loops.                                       |
| `.runHealth()`              | Runs the configured health provider.                          |

### Typed errors

> Added in `0.2.0`. `AgentApiError` / `AgentAuthError` are `@deprecated`
> aliases that reference the very same class values as `ConnectorApiError` /
> `ConnectorAuthError` — not separate classes. Code that catches or
> `instanceof`-checks the old names therefore keeps working unchanged, and
> the runtime `error.name` strings are frozen.

The SDK surfaces four error classes so callers can branch on the failure
mode without parsing messages:

| Class                 | When it's thrown                                                                                                                                        | Should the caller retry? |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `RegistrationError`   | `/api/agents/register` rejects the one-time token (expired, revoked, already used, malformed). Needs operator action — mint a fresh registration token. | No.                      |
| `ConnectorAuthError`  | Any non-register call returns 401/403. The agent token has been revoked or the Connector disabled. Re-register before resuming.                         | No.                      |
| `NetworkError`        | `fetch()` threw before getting an HTTP response (DNS failure, ECONNREFUSED, abort, timeout). `status === 0`; carries an optional `cause`.               | Yes — SDK already does.  |
| `ConnectorApiError`   | Catch-all parent. Direct instances carry HTTP 4xx/5xx that don't fit the more specific cases (e.g. 409 conflict, 422 validation, 5xx server error).     | Only on 5xx.             |

The SDK's internal `retry()` loop already implements this policy: only
`NetworkError` and 5xx `ConnectorApiError` are retried with exponential backoff;
4xx — including the two typed subclasses — surfaces immediately so the caller
isn't waiting on a backoff that can never succeed.

```ts
import {
  XtrapeConnector,
  RegistrationError,
  ConnectorAuthError,
  NetworkError,
} from "@xtrape/connector";

try {
  await connector.start();
} catch (err) {
  if (err instanceof RegistrationError) {
    console.error("registration token is no longer valid:", err.code);
    process.exit(64);
  }
  if (err instanceof ConnectorAuthError) {
    console.error("agent token rejected — was the Connector revoked?");
    process.exit(65);
  }
  if (err instanceof NetworkError) {
    console.error("could not reach the Xtrape control plane:", err.message);
    process.exit(75);
  }
  throw err;
}
```

### Structured logger

> Added in `0.2.0`. Existing zero-config callers (no `logger` / no
> `structuredLogger`) keep using the global `console` exactly as before.

By default the SDK calls `console.debug` / `.info` / `.warn` / `.error`. For
JSON-line logging, pino, OpenTelemetry, or any in-house collector, pass a
`structuredLogger`:

```ts
import { XtrapeConnector, type StructuredLogger } from "@xtrape/connector";

const collector: StructuredLogger = {
  log({ level, message, fields }) {
    process.stdout.write(JSON.stringify({ t: Date.now(), level, message, ...fields }) + "\n");
  },
};

const connector = new XtrapeConnector({
  // ...
  structuredLogger: collector,
});
```

Each record arrives as `{ level: "debug" | "info" | "warn" | "error",
message: string, fields?: Record<string, unknown> }`. The SDK normalizes the
optional context before emitting:

- `Error` instances become `{ error: { name, message, stack } }` so they
  survive `JSON.stringify`.
- Primitives become `{ value: <primitive> }`.
- Plain objects pass through unchanged.

In all cases the redactor runs over `fields` first, so tokens and
secret-bearing keys never reach the collector. If both `structuredLogger`
and `logger` are configured, `structuredLogger` wins.

## Version Compatibility

| Package                            | Compatible with                                               |
| ---------------------------------- | ------------------------------------------------------------- |
| `@xtrape/connector@0.8.5` | Checkpoint↔Action edge published + validated (contracts 0.8.13, docs#228 D1); online Checkpoint growth (`handle.publishCheckpoints`, serial mutation boundary); checkpoints FACTORY with a bounded bootstrap facade (profile discovery + artifact publication, never the raw credential); live-catalog completeness rules startup-only (D5 removals flow through); `@xtrape/contracts@^0.8.13` |
| `@xtrape/connector@0.8.4+` | Xtrape `0.8` milestone; the action list is read LIVE again (a catalog that changes at runtime reaches the Platform without re-registration — 0.8.2/0.8.3 froze it at startup); execute/prepare `context.origin` (the delivered Account context, xtrape-docs runtime-platform/12) and the `features.commandOrigin` capability bit; `@xtrape/contracts@^0.8.7` |
| `@xtrape/connector@0.8.2` | Xtrape `0.8` governed authority milestone; publishes immutable Schema + Checkpoint + exact Action binding descriptors for Platform admission; `@xtrape/contracts@^0.8.6` |
| `@xtrape/connector@0.8.1` | Xtrape `0.8` milestone; `@xtrape/contracts@^0.8.6` (the 0.8.6 delivery wire makes `timeoutSeconds` optional — a deliberate break with pre-0.8.6 parsers, contracts#14) |
| `@xtrape/connector@0.8.0` | Xtrape `0.8` milestone (wire-compatible with the `0.7` line; `@xtrape/contracts@^0.7.6`) |
| `@xtrape/agent@0.7.x` (former name) | Xtrape `0.7` milestone (`xtrape-server-ce` >= 0.7.0, `@xtrape/contracts@^0.7.0`) |
| `@xtrape/agent@0.1.x` | Xtrape Panel CE `0.1.x` and `@xtrape/contracts@0.1.x` |

Pin matching milestone (`MINOR`) versions across CE, Connector SDK, and Contracts;
patch numbers may differ per component. The wire protocol may still change
before `v1.0`.

## Troubleshooting

### Registration fails with `401 / REGISTRATION_TOKEN_INVALID`

The token is single-use and short-lived.

- Check the token has not already been consumed by an earlier successful start
  (registration tokens flip to `USED` on first use).
- Check the token has not expired. Operators set `expiresInSeconds` when
  creating the token; the default in CE is short.
- Check the token has not been revoked from the Xtrape Panel console.
- Re-create a fresh token in the console and start the Connector with it.

### Connector reports `ECONNREFUSED` / cannot reach the Platform

- Confirm `XTRAPE_SERVER_URL` resolves from inside the container or host
  where the Connector runs. `backendUrl` is required — the SDK has no built-in
  default; the `http://localhost:8080` fallback in the examples above only
  works when the Connector runs on the same host as the Xtrape control plane
  (`xtrape-platform-ce`).
- If you sit behind a reverse proxy, point `backendUrl` at the proxy URL —
  not the internal control-plane container address.
- Outbound HTTPS through corporate proxies: respect `HTTPS_PROXY` /
  `NO_PROXY` env vars (`undici` honors them via `setGlobalDispatcher`).

### Agent token file is rejected on second start (`401 / UNAUTHORIZED`)

- File permissions: the Connector process must be able to read
  `tokenStore.file`. Run `chmod 600` (owner read/write) and ensure the
  process owner matches.
- File contents: the SDK writes `<agentId>:<agentToken>` plaintext. If the
  file exists but contains anything else, delete it and re-register with a
  fresh registration token.
- Token revocation: an operator may have revoked the Connector or the agent
  token from the console. Inspect the Connector's status in Xtrape Panel; if it shows
  `REVOKED` or `DISABLED`, that's the cause.

### Heartbeats succeed but action results never arrive

- Confirm the action `name` registered with `connector.action({ name: "..." })`
  matches the `actionName` the Platform dispatches in the command. The SDK
  reports `ACTION_HANDLER_NOT_FOUND` if they differ.
- Confirm `start()` is awaited and not called repeatedly — multiple
  `XtrapeConnector` instances on the same host with the same connector code will
  fight over heartbeats and command polls.
- Check `commandPollMs` / `commandPollIntervalSeconds` is not absurdly
  large; default is 5s.

## Documentation

- Canonical docs: internal design reference; public usage is described in this README
- Build your first Service: internal design reference; public usage is described in this README
- Action model: internal design reference; public usage is described in this README
- Transport & command delivery: internal design reference; public usage is described in this README
- Panel CE overview: internal design reference; public usage is described in this README
- Website source (historical 0.6-era guides live here): internal design reference; public usage is described in this README

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow and PR checks.
See [SECURITY.md](./SECURITY.md) for vulnerability reporting and token/action
safety guidance.

## License

Apache-2.0. "Xtrape" and "Opstage" are trademarks of their
respective owners; the open-source license does not grant trademark rights.

## v0.4 Experimental legacy event routing Hook

The SDK exposes a minimal experimental publish hook into CE's built-in SQLite-backed in-process event-to-command router:

```ts
await connector.publishBusEvent({
  eventType: "demo.item.created",
  payload: { itemId: "item-1" },
});
```

The hook posts to the Xtrape control plane as the registered embedded Connector (`POST /api/agents/:connectorId/bus/events`, a frozen route) and defaults `sourceServiceCode` to the configured service code.

Typed errors for Bus failure modes:

- `BusDisabledError` — `CAPSULE_BUS_DISABLED` (404)
- `BusRateLimitedError` — `BUS_RATE_LIMITED` (429)
- `BusDepthExceededError` — `BUS_DEPTH_EXCEEDED` (422)

legacy event routing is experimental in v0.4: not a standalone Bus Server, external broker, workflow engine, or service mesh API.

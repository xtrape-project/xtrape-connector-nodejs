
All notable changes to `@xtrape/connector` (formerly `@xtrape/agent`, earlier `@xtrape/capsule-agent-node`) are documented in this file.

This project follows semantic versioning. Pre-`v1.0.0` minors may include breaking changes; pin matching minor versions across CE, the Connector SDK, and the Contracts package.

## [Unreleased]

_Nothing yet._

## [0.8.7] — 2026-09-07

### Added — the REVIEW step of a two-phase Checkpoint (xtrape-docs#288 / runtime-platform/13; #108)

- World A: a `REVIEW` delivery (`@xtrape/contracts` 0.8.16, `DeliveredCommand.operation = EXECUTE | REVIEW`) is routed to `CeLongPollHandlers.onReview` — **required** (a loop never acks a review it cannot answer) — and answered on the report path as `{ next: { inputSchema, initialPayload, currentState } }` (`ReviewCommandResultSchema`), never run as an execute.
- `CeServiceActionDefinition.review?(input, context)` with `CeReviewContext` (`commandId`, `origin`, `filterResources(candidates)` — the runtime-platform/13 §4.3 candidate exchange, `CeServiceConnector.filterCandidateResources`, Platform endpoint platform-ce#312). An action that declares `prepare` but no `review` is answered from `prepare()` (13 §9 alias; `inputSchema` falls back to the action's own); the alias hands `prepare` the same exchange as `CePrepareContext.filterResources` (absent on the legacy `/prepare` door).
- Dial transport: `POST /actions/:name/review` is a Command door — `x-xtrape-command-id` is required (`400 COMMAND_ID_REQUIRED`; the commandless compatibility surface stays the legacy `/prepare` door) — under the execute command lifecycle: admitted through the command registry (a CANCEL that arrived first wins: `409 CANCELLED`; a CANCEL that arrives while the handler runs discards the late result and settles the command as cancelled; `CeReviewContext.signal` is aborted), and the frozen `next` is kept ON the registry tombstone so a retry of the same command id replays the same `next` for exactly as long as the registry remembers the command (13 §5.5). A registered instance declares `features.review` (`REVIEW_FEATURE`); a listen-only instance has no lifecycle credential for the exchange and does not.
- `reviewFaceFor(definition, face)` accepts `candidateParameter` (runtime-platform/13 v0.5 §4.3; `@xtrape/contracts` 0.8.17): the execution-schema property the candidate exchange fills.
- `reviewFaceFor(definition, face)` authors a Checkpoint's review face (`risk` defaults to the execution risk, `resource` to the execution extraction, `affinity` to `INCARNATION`); startup preflight checks the review face's schema records like the execution face's. `CeReviewContext`, `CeReviewResult`, `REVIEW_FEATURE` are root exports.
- Legacy catalog: an action with `review` (not only `prepare`) advertises `requiresPrepare: true`, so an older Platform never dispatches it single-phase.

### Changed

- A delivered `EXECUTE` of a two-phase action no longer fails `PREPARE_UNSUPPORTED_ON_LONG_POLL`: the Platform dispatches it only after an admitted review of the same Checkpoint (13 §6), and the action verifies the review binding it sealed.
- `@xtrape/contracts` peer floor `^0.8.17` (raised to `^0.8.16` for the REVIEW delivery in #109, then to `^0.8.17` for `review.candidateParameter` in #110 — one floor for this release).

## [0.8.6] — 2026-08-27

### Added

- `computeBuildArtifactDigest(root)` / `BuildArtifactIdentity` — the Widget's
  self-reported build identity (owner ruling on platform-ce#253; arch/16
  §17.1 item 10): a `sha256:`-prefixed digest over a canonical manifest of
  the code under `root`, the same construction the Platform applies to
  itself. Deterministic, content-sensitive, fail-closed on an empty tree.
- `ServeCeServiceOptions.buildRoot` — when set, the SDK computes the
  identity over the Widget's built module tree at startup and injects
  `manifest.build.artifactDigest` (the artifact identity the Platform's
  Widget TargetAdmission requires for GOVERNED registrations). A manifest
  that already carries `build` must agree with the computed value;
  disagreement is refused before any registration request leaves.

### Changed

- `@xtrape/contracts` floor raised to `^0.8.14` (the `manifest.build`
  field).

## [0.8.5] — 2026-08-25

### Added

- **The Checkpoint↔Action edge is published and validated by the SDK**
  (#52/#97; contracts 0.8.13, docs#228 D1): a Service-published definition
  without `action{actionId}` is unparseable at the SDK boundary, and
  `serveCeService` refuses a disagreeing edge (declared vs binding Action)
  BEFORE publishing — the same rule-4 refusal Platform admission gives.
- **Online growth of the published Checkpoint set** (#98/#99):
  `handle.publishCheckpoints(definitions, newSchemaRecords?)` — one serial
  mutation boundary (preflight → durable publish → merge as a critical
  section over a promise chain); intra-batch duplicate Checkpoint keys and
  schema digests are refused pre-durable, an already-known schema digest is
  an idempotent skip, and a concurrent identical growth re-preflights
  against the winner's merged snapshot. World A only.
- **Checkpoints FACTORY** (#100/#101): `opts.checkpoints` may be an async
  factory called once between `register()` and the descriptor publication,
  receiving a BOUNDED facade — `instanceId`, `listExecutionProfiles()`
  (platform-ce#262), `publishResourceExtractorArtifact()` (platform-ce#207)
  — never the raw instance credential. Built for definitions that must cite
  an admitted execution-profile digest, discoverable only with the
  registered instance's authority. World B (listen-only) refuses a factory.

### Changed

- **Live catalog vs D5** (#97, review 2664): the completeness rules
  ("every action binds / every checkpoint bound") are STARTUP-only. A
  governed Action removed or renamed at runtime now flows through the live
  catalog — the Platform resolves the affected Checkpoint UNDISPATCHABLE
  until the exact reference returns (docs#228 D5) — while consistency
  breaks (duplicate names, unpublished bindings, a disagreeing edge) still
  keep the last valid view.
- `@xtrape/contracts` peer moved to `^0.8.13`.

## [0.8.4] — 2026-08-18

### Fixed

- **The action list is read LIVE again.** 0.8.2 snapshotted `opts.actions`
  at startup while adding the authority-descriptor validation, which silently
  froze the catalog of any Service that changes its actions at runtime —
  linux-ops-widget's task library grows online and a governed content
  version applied by its poll rebuilds the ops entries in place (contract
  documented there since #55: "serveCeService keeps this array by
  reference"). Found by the m1-local zero-shot loop (2026-08-18): a merged
  task never reached the Platform catalog. `GET /actions` and the
  execute/prepare lookups now read the caller's array on every access; the
  validation runs at startup (throws) and on every read (a change that
  breaks an invariant keeps the last valid view and is reported once).

## [0.8.3] — 2026-08-18

### Added

- **`CeExecuteContext.origin`** — the authenticated Account context the
  Platform delivered a command under (`@xtrape/contracts` `CommandOrigin`,
  design xtrape-docs runtime-platform/12, #256): `{ account?, traceId? }` —
  the canonical Account id when the Platform could map the subject to one,
  no class field, not the actual originator. Passed to `execute` exactly as
  delivered; absent when the Platform did not send one, which an action must
  read as `{}`. A fact for attribution and forwarding — never a credential,
  never a policy-branch input, never taken from the action's input.
- **`CePrepareContext.origin`** — two-phase `prepare(input, context)` receives
  the same delivered Account context on the World B prepare dial, so a
  review card can attribute or refuse before any command exists.
- World B: the origin arrives on the Platform-set `x-xtrape-command-origin`
  header of the dial (`COMMAND_ORIGIN_HEADER`); the request body stays a
  strict `CommandDispatchRequest`, so nothing a caller can put in a body
  becomes an origin. A malformed header reads as absent, never as an error.
- `serveCeService` now declares `features.commandOrigin: true` in the
  registered manifest: this SDK parses the field, so the Platform may send
  it. Older SDKs never declare it and keep receiving the delivery they
  always did — the feature bit is what makes an optional wire field safe
  against strict consumers.

### Changed

- Requires `@xtrape/contracts` ≥ 0.8.7 (`CommandOrigin`, `COMMAND_ORIGIN_FEATURE`).

## [0.8.2] — 2026-08-14

### Added

- `serveCeService` accepts content-addressed `schemaRecords`, immutable
  `checkpoints`, and exact per-Action `checkpoint` bindings. World A publishes
  one atomic authority descriptor with the Worker's authenticated access
  token; World B exposes the same authenticated `/descriptor` snapshot containing
  the manifest, Action catalog, schemas, and Checkpoints. Startup fails closed
  on cross-Service Checkpoints, missing schema records, digest mismatches,
  duplicate identities, or a non-bijective Action↔Checkpoint mapping.
- Authority metadata is copied at startup and used for both descriptor reads
  and execution lookup; later mutation of caller-owned arrays/objects cannot
  alter an admitted binding. A failed World A admission deregisters the Worker
  incarnation before startup returns an error.
- `CeServiceConnector.publishAuthorityDescriptor()` is the governed low-level
  publication primitive. The older per-record methods remain compatibility
  primitives and do not activate a complete authority revision by themselves.
- `CeServiceConnector.publishSchemaRecords()` and
  `CeServiceConnector.publishCheckpoints()` for services that own their HTTP
  surface instead of using `serveCeService`.
- World B now distinguishes an absent governed descriptor from an invalid one:
  Services without Checkpoints return `404 AUTHORITY_DESCRIPTOR_NOT_AVAILABLE`
  from `/descriptor`, preserving the authenticated legacy `/actions` fallback
  without permitting malformed governed metadata to downgrade.
- World A binds its listener before registration so an ephemeral callback port
  can be reported, but keeps messages, the Action catalog, prepare, execute and
  cancel behind `503 NOT_READY` until registration and any governed descriptor
  admission both succeed. Admission failure never opens the handlers and closes
  the listener after deregistering the half-started Worker.

## [0.8.1] — 2026-08-09

### Added

- **`ask()` — the interaction primitive** (connector-nodejs#87, canonical
  xtrape-docs#241): a Service asks a person a question through the Platform
  and gets the answer back, with zero new wire — `APPROVAL_REQUEST` posted
  into a `targetType: SYSTEM` conversation, answered by `APPROVAL_RESPONSE`
  with a REQUIRED exact `replyToMessageId`. One live question per
  conversation; waiter registers before the post (no fast-answer race); an
  already-aborted signal refuses before posting anything.
- **`CommandRegistry` — the World B command lifecycle** (#87 reviews
  2178–2208; the PR's boundary section records this as reviewer-driven
  scope): the business action executes once, its terminal outcome is retried
  by its own owner until the Platform semantically accepts it. Admission
  precedes classification on every transport (a CANCEL that arrived first
  wins over `ACTION_NOT_FOUND`; a settled command's redelivery is deduped,
  never reclassified); `POST /commands/:id/cancel` answers the frozen
  `CommandCancelResponse` union and aborts the matching execution; a cancel
  landing during the body read stops the action before it starts; the
  settled tombstone remembers the PLATFORM's canonical terminal status
  (`CommandReportAck.canonicalStatus`); report claims are single-flight
  (`claimDueRetries`), failed reports back off 2s→60s and never give up;
  permanent HTTP refusals (400/403/404/409/410/422) surface as
  `HTTP_REJECTED` via `onReportRejected` instead of retrying for ever
  (`CePlatformHttpError` carries the status).

### Changed

- **No client-side deadline** (canonical xtrape-docs#242):
  `CeExecuteContext.timeoutSeconds` is disclosure — nothing on the Connector
  ends an action by elapsed time; what ends a running action is the action
  finishing or an explicitly relayed cancel.
- `@xtrape/contracts` dependency floor moves `^0.7.6` → `^0.8.6` (the 0.8.x
  cascade, docs#44; 0.8.6 REQUIRED rather than 0.8.5 because this SDK parses
  World A deliveries with `CommandPollResponseSchema` at runtime, and only
  0.8.6 accepts a delivery that legitimately omits `timeoutSeconds` —
  release-train ordering per review 2223). Adopting 0.8.6 also required the
  code migration below, because 0.8.6 deletes the names this SDK imported.
- **Contracts symbol migration (forced by the 0.8.6 floor, inseparable from
  it)**: `ServiceInstance`/`ServiceInstanceSchema`/`ServiceInstanceHealth` →
  `Worker`/`WorkerSchema`/`WorkerHealth` (contracts#99 D13);
  `RegisterAgent*`/`AgentHeartbeat*` wire DTO imports → the `Connector*`
  primaries (the SDK's own published `@deprecated` Agent-named aliases are
  KEPT — they now alias the Connector-named wire types); the registration
  payload drops its `mode: "embedded"` field and the reported Worker manifest
  drops `agentMode` (contracts#99 D2 removed the ConnectorMode concept and both
  fields with it). Typecheck, lint and the
  151-test suite ran against the registry-resolved 0.8.6 (installed version
  asserted before gating).

## [0.8.0] — 2026-07-26

### Changed

- **Package renamed `@xtrape/agent` → `@xtrape/connector`** and **class renamed `XtrapeAgent` → `XtrapeConnector`** per the 0.8.0 concept freeze (agent-nodejs#75; repository renamed `xtrape-agent-nodejs` → `xtrape-connector-nodejs`). Canonical Connector-named symbols are now the primaries across the published TypeScript surface (including `CeServiceConnector`, see the naming-plane entry below); every former Agent-named export — `XtrapeAgent`, `XtrapeAgentOptions`, `CeServiceAgent`, `AgentApiClient`, ... — remains exported only as a `@deprecated` alias of its canonical primary (same class/type values, so `instanceof` and existing imports keep working). What is genuinely unchanged are the wire and runtime bytes: endpoint routes (`/api/agents/*`, `/v1/instances/*`), JSON payload keys (`agent`, `agentId`, `agentToken`), token prefixes (`agt_`, `opstage_agent_`), error `code` values, and runtime `error.name` strings. `serveCeService` is concept-neutral and kept as-is.
- The old `@xtrape/agent` package will later receive a thin forwarding release that re-exports `@xtrape/connector` (separate change, not in this repository's 0.8.0). Published `0.7.x` artifacts are untouched.
- **Naming-plane finish (connector-nodejs#79, PR #80)**: canonical Connector-named primaries across the published TypeScript surface, with every former Agent-named export retained as a `@deprecated` alias (value + type where the primary is a class — same object, so `instanceof` and subclassing keep working). Alias pairs added in this change: `ConnectorMode`←`AgentMode`, `ConnectorLogLevel`←`AgentLogLevel`, `ConnectorLogRecord`←`AgentLogRecord`, `CeServiceConnector`←`CeServiceAgent`, `CeServiceConnectorOptions`←`CeServiceAgentOptions`, `ConnectorApiClient`←`AgentApiClient`, `ConnectorApiError`←`AgentApiError`, `ConnectorAuthError`←`AgentAuthError`, `classifyConnectorApiError`←`classifyAgentApiError` (module-level), `WorkerConnectorOptions`←`WorkerAgentOptions`, `LegacyServiceConnectorOptions`←`LegacyServiceAgentOptions`. Options gain a canonical `connector` identity key (`agent` stays as a deprecated fallback; `connector` wins when both are set), and `ServeCeServiceHandle` gains a canonical `connector` property (`agent` deprecated, same instance). Wire values are untouched: endpoint paths, the registration payload's `agent` field, `agt_`/`opstage_agent_` prefixes, error `code` values, and the runtime `error.name` strings (still "AgentApiError"/"AgentAuthError"). Prose/docs updated to "Embedded Connector mode" (formerly Embedded Agent mode; sidecar/external likewise) and "Connector SDK"; Agent Token credential semantics unchanged; `serveCeService` unchanged (concept-neutral). Example renamed `examples/minimal-agent.ts` → `examples/minimal-connector.ts`, and all examples now exercise the canonical `worker` + `connector` option path.
- **Contracts DTO facade (PR #80 review 2)**: the SDK now exports canonical Connector-named aliases over the `@xtrape/contracts` Agent-named DTOs — `RegisterConnectorRequest`←`RegisterAgentRequest`, `RegisterConnectorResponse`←`RegisterAgentResponse`, `ConnectorHeartbeatRequest`←`AgentHeartbeatRequest` (identical types; the old names are also exported from the SDK as `@deprecated` aliases). `ConnectorApiClient` public method signatures use the facade names and `connectorId` parameter names (pure DTS surface; wire routes stay `/api/agents/*` and JSON payload keys are frozen). The deprecated `AgentApiClient` alias inherits the new signatures (same class). Native Connector-named DTO primaries in `@xtrape/contracts` itself are a contracts-nodejs follow-up. Runtime prose, log messages, and user-facing SDK error strings now say Connector ("Connector options require `worker`...", "connector start failed", "Connector must be started before publishing routed events"); frozen `error.name`/`code` values unchanged. Internal source file renamed `src/client/agent-api-client.ts` → `src/client/connector-api-client.ts` (not a published subpath — the package exposes only the root export).

## [0.7.4]

### Added

- **World A long-poll delivery (agent-nodejs#44, contracts 0.7.4, docs/09 §5.1/§5.4)**: when the registration response carries server-authoritative `transport` parameters (`WorldACeRegistrationResponse`), `serveCeService` starts a `CeLongPollLoop` — hanging `GET /v1/instances/:id/deliveries/poll` (client read timeout = server `waitMs` + 15s margin; the server is the hanging side), immediate re-poll on 200/204 with a hot-loop floor, exponential backoff on transport errors (1s→30s, reset on success), and a fatal stop + `onFatal` on 401/404/409 (stale credential/incarnation or de-provisioned transport — re-registration is the service's decision). At-least-once: a bounded LRU dedupes by stable `commandId`/`cancelId`/`messageId`, duplicates are re-acked without re-dispatch, and EVERY `deliveryId` is acknowledged after local acceptance — ack means "received", results always ride the report path.
- Delivered **EXECUTE** commands run with an extensible execution context (`execute(input, { signal, commandId, timeoutSeconds })`, docs#97 B5 direction) and LOCAL enforcement of the delivered remaining budget: timeout aborts the signal and reports `FAILED` with `failureReason: "TIMEOUT"` on the 0.7.3 CE report dialect (instance-claimed); a delivered **CANCEL** aborts the in-flight signal and reports `FAILED(CANCELLED)`; a routed **MESSAGE** runs the message handler and posts the reply through the outbound persist-only message route (doc §9 note). Unexpected **PREPARE** deliveries are acknowledged and dropped with a warning (prepare has no contracted return path on this transport yet).
- `CeServiceAgent`: registration parses/validates `transport` strictly (`transportParameters` getter), `reportCommandResult` accepts `failureReason` (switches onto the CE report dialect), and `postMessageEnvelope` posts a prebuilt ConversationMessage envelope.
- `serveCeService.close()` stops the loop first, drains in-flight executions (bounded 10s), then deregisters.

### Changed

- **Package renamed `@xtrape/capsule-agent-node` → `@xtrape/agent`**, and its contracts dependency renamed to `@xtrape/contracts` (the `capsule` identifier is a retired product concept). First publish under the new name is 0.7.4 — the old name was never published for the agent, so there is no deprecation tail here.
- **`XtrapeAgent` is now the canonical class** (`src/xtrape-agent.ts`), and `XtrapeAgentOptions` the canonical options type. `CapsuleAgent` / `CapsuleAgentOptions` remain as `@deprecated` aliases (surfaced in the published `.d.ts`, so IDEs flag migration) and are removed with the other Capsule-era identifiers before 0.7.6.
  *(folded from a stale duplicate Unreleased section — these rename notes shipped with 0.7.4.)*

- `GET /actions` no longer advertises the per-action `async` flag — the transport is uniformly async (docs/09 §6) and the flag was never contracted. It still selects the 202 path on the legacy push transport. Requires `@xtrape/capsule-contracts-node` ^0.7.4.

## [0.7.0]

> Version correction: async action support below belongs to the **0.7 milestone**
> (server-ce#41). It was mistakenly published to npm as `0.6.2`; `0.6.2` is
> deprecated in favor of the identical `0.7.0` (which pins contracts `^0.7.0`).

### Added

- Async action completion (server-ce#41 Stage B): `CeServiceAgent.reportCommandResult()` posts the outcome to `POST /v1/instances/:instanceId/commands/:commandId/result` with the per-instance access token; `CeServiceActionDefinition.async` marks long-running actions — when the pushed execute carries `x-xtrape-command-id`, `serveCeService` replies `202 { status: "RUNNING", commandId }`, runs the handler in the background, and reports COMPLETED/FAILED. Without the header (older server-ce) async actions fall back to synchronous execution. Requires `@xtrape/capsule-contracts-node` ^0.7.0.

## [0.6.1]

### Added

- Two-phase CE actions: `CeServiceActionDefinition.prepare()` and a `POST /actions/:name/prepare` endpoint on `serveCeService`, advertised as `requiresPrepare: true` in the action list, so operators get live defaults/current state before executing.
- Inbound CE service action serving (`GET /actions`, `POST /actions/:name/execute`) and authenticated server-ce callbacks (`callbackToken`) for `CeServiceAgent` / `serveCeService`.

### Notes

- Additive since 0.6.0; no API breaks. First consumer: `anyapi-chatgpt` CE migration.



## [0.4.0-rc.0]

### Added

- `publishBusEvent(input)` — minimal publish hook into CE's built-in SQLite-backed in-process event-to-command router.
- Typed Bus errors: `BusDisabledError` (`CAPSULE_BUS_DISABLED`), `BusRateLimitedError` (`BUS_RATE_LIMITED`), `BusDepthExceededError` (`BUS_DEPTH_EXCEEDED`).

### Changed

- `PublishBusEventInput` now derives from the exported `PublishBusEventRequest` type instead of `z.input<typeof PublishBusEventRequestSchema>`.

## [0.1.0] - 2026-05-01

The first publicly usable release of the Node embedded Agent SDK.

### Added

- `CapsuleAgent` class with `start()` / `stop()` / `runHealth()` lifecycle.
- Registration flow exchanging a one-time registration token for a long-lived Agent token; persisted via `FileTokenStore`.
- Heartbeat, service report, and command-poll loops with configurable intervals.
- Health provider hook (`agent.health(...)`).
- Config provider hook (`agent.configs(...)`) with typed `ConfigItem` entries (sensitive / secretRef / valuePreview).
- Action registration (`agent.action(...)`) with `dangerLevel`, `requiresConfirmation`, `inputSchema`, optional `prepare`, and `handler`.
- `ACTION_PREPARE` / `ACTION_EXECUTE` two-phase command handling.
- Default prepare payload generation from `inputSchema` defaults when no prepare handler is provided.
- Outbound-only HTTPS to the Opstage backend; no inbound listener.
- Log redaction helpers for secret-bearing fields.

### Compatibility

- Targets Opstage CE `0.1.x`.
- Pairs with `@xtrape/capsule-contracts-node@0.1.x`.

### Status

- Not yet published to npm. Consume from the workspace inside `xtrape-capsule-ce` or from a local checkout until the v0.1.0 Public Preview cut.

<!-- Historical version Unreleased: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.7: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.6: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.5: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.4: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.3: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.2: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.1: private comparison is not available in this public snapshot. -->
<!-- Historical version 0.8.0: private comparison is not available in this public snapshot. -->
<!-- Historical 0.1.0 release link retired; no public tag is claimed. -->

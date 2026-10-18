import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { computeBuildArtifactDigest } from "./build-identity";
import {
  CE_CONTRACT_VERSION,
  COMMAND_ORIGIN_FEATURE,
  COMMAND_ORIGIN_HEADER,
  CheckpointDefinitionSchema,
  CheckpointVersionIdSchema,
  ServiceManifestSchema,
  checkpointVersionKey,
  type CheckpointDefinition,
  type CheckpointVersionId,
  CommandOriginSchema,
  type CommandOrigin,
  type ServiceManifest,
  type StreamDelivery,
  ReviewCommandResultSchema,
  type ReviewNext,
} from "@xtrape/contracts";

/**
 * The manifest feature a Connector declares when it speaks the REVIEW step of
 * a two-phase Checkpoint on the dial transport (`POST /actions/:name/review`,
 * runtime-platform/13 §9). World A needs no flag: a REVIEW delivery is a wire
 * value an old union cannot parse. This SDK always declares it.
 */
export const REVIEW_FEATURE = "review" as const;
import {
  CeInboundMessageValidationError,
  CeServiceConnector,
  type CeMessageHandler,
  type CeAuthorityDescriptor,
  type CeSchemaRecordDefinition,
} from "./index";
import { CeLongPollLoop } from "./long-poll";
import { CommandRegistry, type CommandStopCause } from "./command-registry";

/**
 * One-call bootstrap for an `xtrape-service`: start an HTTP listener that serves
 * `POST /messages`, action endpoints (and `GET /health`), register the instance to xtrape-platform-ce,
 * and run heartbeats. Returns a handle whose `close()` stops heartbeats,
 * deregisters, and closes the listener.
 *
 * Uses only `node:http` so it stays framework-agnostic. A service that already
 * has an HTTP server can use `CeServiceConnector` directly instead.
 */
export interface ServeCeServiceOptions {
  /** xtrape-platform-ce base URL, e.g. http://localhost:3000 */
  serverUrl: string;
  manifest: ServiceManifest;
  /** business handler invoked per inbound ConversationMessage */
  handler: CeMessageHandler;
  /** Optional CE action handlers exposed over GET /actions, POST /actions/:name/prepare, and POST /actions/:name/execute. */
  actions?: CeServiceActionDefinition[];
  /**
   * Immutable authorization Checkpoints implemented by this Service.
   *
   * World A publishes them through the Worker's authenticated instance route
   * immediately after registration. World B exposes the same definitions in
   * the authenticated descriptor for operator provisioning. When this array is
   * non-empty every Action must bind exactly one unique Checkpoint.
   *
   * MAY be an async FACTORY (connector-nodejs#100): definitions that cite an
   * admitted execution-profile digest can only be built AFTER registration —
   * the discovery endpoint (platform-ce#262) and the artifact-publication
   * route both take the instance's access token. A factory is called once,
   * between `register()` and the descriptor publication, with a BOUNDED
   * facade (never the raw credential — review 2671): profile discovery,
   * artifact publication, and the instance id; the startup completeness validation of the action
   * list runs after it resolves (operational readiness waits on descriptor
   * admission either way). World B (listen-only) has no registration and
   * accepts only the plain array.
   */
  checkpoints?: CheckpointDefinition[] | ((ctx: CheckpointFactoryContext) => Promise<CheckpointDefinition[]>);
  /** Content-addressed schemas referenced by `checkpoints`; published first. */
  schemaRecords?: CeSchemaRecordDefinition[];
  /**
   * Root of the BUILT module tree this Widget runs (e.g. its `dist/`).
   * When set, the SDK computes the self-reported build identity over it at
   * startup (`computeBuildArtifactDigest`, the Platform's own construction)
   * and injects `build.artifactDigest` into the manifest — the artifact
   * identity the Platform's Widget TargetAdmission requires for GOVERNED
   * registrations (owner ruling on platform-ce#253; a governed registration
   * without it publishes and discovers but is NOT admissible, so Approval /
   * Confirmation stay fail-closed against it). A manifest that already
   * carries `build` wins over this option; providing both with different
   * values is refused rather than silently resolved.
   */
  buildRoot?: string;
  /** shared registration token, if platform-ce requires one */
  registrationToken?: string;
  /**
   * 0.6.x control-plane token forwarded to platform-ce on heartbeat/deregister
   * only as a compatibility fallback. Current platform-ce returns a per-instance
   * access token during registration and the SDK uses that first.
   */
  controlToken?: string;
  /**
   * Optional inbound callback token. When set, `POST /messages` and action
   * endpoints (`GET /actions`, `POST /actions/:name/prepare`,
   * `POST /actions/:name/execute`) must include
   * `x-xtrape-service-callback-token: <callbackToken>` (or
   * `Authorization: Bearer <callbackToken>`); otherwise the request is rejected
   * with 401. Lets a service require authenticated callbacks from platform-ce.
   */
  callbackToken?: string;
  /**
   * World B / listen-only mode (canonical runtime-platform/09 §4, platform→connector):
   * the service only DEPLOYS — it never dials the Platform. It issues its own
   * `callbackToken` (required in this mode, fail-closed), exposes this HTTP
   * surface, and the operator records address + token in platform-ce, which
   * verifies them with a first connection and becomes the dialing side.
   * No registration, no heartbeat, no long-poll; action results are returned
   * synchronously because the report path needs registration credentials.
   *
   * LIMIT, stated because it is structural rather than an oversight: with no
   * report path, an action here cannot settle after the Platform's forward
   * window closes. An action that may outlive that window — anything waiting
   * on a person through `ask()`, which also needs the instance credential this
   * mode does not have — is not supportable in listen-only mode. Register the
   * service (World A or registered push) for those.
   */
  listenOnly?: boolean;
  /** listen port; 0 picks an ephemeral port (default 0) */
  port?: number;
  /** listen host (default 0.0.0.0) */
  host?: string;
  /**
   * Address platform-ce should call back.
   *
   * Required for deployed/containerized use. When omitted, the SDK only derives
   * a default address for explicit local-only hosts such as `127.0.0.1` or
   * `localhost`.
   */
  address?: string;
  /** heartbeat interval ms; 0 disables (default 10000) */
  heartbeatMs?: number;
  /**
   * Called when the Platform answered a terminal report with a refusal it will
   * keep answering — UNKNOWN_COMMAND or OWNERSHIP_MISMATCH on the frozen
   * union, or HTTP_REJECTED for a permanent 4xx on the legacy report path.
   * Retrying cannot change any of them, so the outcome is dropped rather than
   * replayed for ever, and this is the only place that fact surfaces.
   */
  onReportRejected?: (info: { commandId: string; outcome: Record<string, unknown>; reason: string }) => void;
  instanceId?: string;
  /** injectable fetch (tests); defaults to global fetch */
  fetchImpl?: typeof fetch;
  /**
   * Called when the provisioned long-poll channel ends permanently (401/404/409).
   * The SDK stops heartbeats and aborts in-flight executions before invoking
   * this callback, so the process cannot remain falsely healthy while no
   * longer receiving commands.
   */
  onTransportFatal?(error: Error): void;
}

/**
 * What a two-phase action's prepare step returns to the operator UI:
 * `initialPayload` seeds the execute form, `currentState` is contextual
 * data to display (e.g. the accounts/balances the decision is based on),
 * and `inputSchema` optionally overrides the static schema with live options.
 */
export interface CeActionPrepareResult {
  /** Longer operator-facing explanation shown on the execution screen. */
  longDescription?: string;
  initialPayload?: Record<string, unknown>;
  currentState?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

export interface CeServiceActionDefinition {
  name: string;
  label: string;
  description?: string;
  /** Operator-facing grouping shown by Panel (0.1-era ActionDefinition heritage), e.g. "diagnostics". */
  category?: string;
  /** Display order within the category; lower sorts first. */
  order?: number;
  inputSchema?: Record<string, unknown>;
  /**
   * Optional per-action duration DISCLOSURE in seconds (connector-nodejs#76).
   * This is REMINDER metadata, nothing more (contracts-nodejs#106,
   * xtrape-docs#242, platform-ce#189): the value announces the duration the
   * author considers normal, and neither the Platform nor a generic Connector
   * synthesizes, clamps, or ENFORCES it — elapsed time never terminalizes a
   * command on any side. An action that wants a real bound applies one itself
   * and reports it (`failureReason: TIMEOUT`). A declared value is carried
   * verbatim on the `/actions` catalog; ABSENT stays absent (no default is
   * invented). Mirrors `CeExecuteContext.timeoutSeconds`, which is the same
   * disclosure handed back on execute — also not a budget. A positive integer;
   * other values are dropped from the catalog so a malformed field never
   * reaches the wire.
   */
  timeoutSeconds?: number;
  /** Exact immutable Checkpoint this Action implements. */
  checkpoint?: CheckpointVersionId;
  /**
   * Optional prepare step. When present the action is two-phase: platform-ce
   * calls this before the operator fills the form to fetch live defaults and
   * current state. Advertised as `requiresPrepare: true` in the action list.
   */
  prepare?(input?: unknown, context?: CePrepareContext): CeActionPrepareResult | Promise<CeActionPrepareResult>;
  /**
   * @deprecated Ignored. The push transport is uniformly async for every
   * action that arrives with an `x-xtrape-command-id` header and has a report
   * path: the listener replies 202 { status: "RUNNING", commandId }, runs
   * `execute` in the background, and reports the outcome via
   * `CeServiceConnector.reportCommandResult`. Selecting that per action was
   * the reason an ordinary long action wrote its result to an abandoned HTTP
   * response and left the command RUNNING for ever. Without the header, or
   * with no report path (listen-only), execution is synchronous because
   * nothing else can carry the outcome.
   */
  async?: boolean;
  /**
   * The REVIEW step of a two-phase Checkpoint (xtrape-docs#288,
   * runtime-platform/13 §3): render the review card, narrow the form, seal
   * the review binding into `initialPayload` — and cause NO side effect. When
   * absent but `prepare` is declared, the SDK answers a review from
   * `prepare()` (the 13 §9 compatibility alias). Target choices go through
   * `context.filterResources` (§4.3) — offer only what comes back.
   */
  review?(input: unknown, context: CeReviewContext): CeReviewResult | Promise<CeReviewResult>;
  execute(input: unknown, context?: CeExecuteContext): unknown | Promise<unknown>;
}

/** What a review answers with — the contracts-fixed `next` envelope (`ReviewNext`). */
export type CeReviewResult = ReviewNext;

export interface CeReviewContext {
  /** Aborted on a delivered CANCEL (dial door); a late result is discarded either way (review 3196). */
  signal?: AbortSignal;
  /** The REVIEW command this review answers (absent on the dial door's direct call without a command header). */
  commandId?: string;
  origin?: CommandOrigin;
  /** runtime-platform/13 §4.3: submit candidate target identifiers; present ONLY the admitted subset that comes back. */
  filterResources(candidates: string[]): Promise<string[]>;
}

/**
 * Extensible execution context (agent-nodejs#42 direction, docs#97 B5): an
 * object — never positional arguments — so later fields (trace identity,
 * Checkpoint/Resource, bounded credentials) are additive.
 */
/**
 * Parse the World B origin header. Anything malformed reads as absent — the
 * action then treats it as an empty context. It never throws: an
 * unparseable audit fact must not become a way to fail a command.
 */
/** Every schema record a Checkpoint definition cites — the execution face and, for a two-phase Checkpoint, its review face (runtime-platform/13 §4.2). */
function schemaRefsOf(definition: CheckpointDefinition): ReadonlyArray<readonly [string, { schemaRecord: string }]> {
  const refs: Array<readonly [string, { schemaRecord: string }]> = [
    ["inputSchema", definition.inputSchema],
    ["outputSchema", definition.outputSchema],
  ];
  if (definition.review) {
    refs.push(["review.inputSchema", definition.review.inputSchema], ["review.outputSchema", definition.review.outputSchema]);
  }
  return refs;
}

/**
 * Author the review face of a two-phase Checkpoint (runtime-platform/13 §4.2;
 * contracts `CheckpointReviewFaceSchema`). Defaults materialize the canonical
 * readings HERE, before serialization, so the wire has one spelling:
 * `risk` = the execution risk (13 §6.1), `resource` = the execution
 * extraction (a Service-rooted review passes its own), `affinity` =
 * `INCARNATION` (13 §5.6) unless the seal is declared portable.
 */
export function reviewFaceFor(
  definition: Pick<CheckpointDefinition, "risk" | "resourceExtraction">,
  face: {
    inputSchema: NonNullable<CheckpointDefinition["review"]>["inputSchema"];
    outputSchema: NonNullable<CheckpointDefinition["review"]>["outputSchema"];
    resource?: NonNullable<CheckpointDefinition["review"]>["resource"];
    risk?: NonNullable<CheckpointDefinition["review"]>["risk"];
    affinity?: NonNullable<CheckpointDefinition["review"]>["affinity"];
    /**
     * 13 v0.5 §4.3: the NAME of the execution `inputSchema` top-level property
     * the candidate exchange fills (`ctx.filterResources`). Declare it when the
     * review offers a target choice; the Platform verifies at admission that
     * the property is declared. Absent = this review runs no exchange.
     */
    candidateParameter?: string;
  },
): NonNullable<CheckpointDefinition["review"]> {
  return {
    inputSchema: face.inputSchema,
    resource: face.resource ?? definition.resourceExtraction,
    outputSchema: face.outputSchema,
    risk: face.risk ?? definition.risk,
    affinity: face.affinity ?? "INCARNATION",
    ...(face.candidateParameter !== undefined ? { candidateParameter: face.candidateParameter } : {}),
  };
}

function parseOriginHeader(raw: string | string[] | undefined): CommandOrigin | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const parsed = CommandOriginSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Context for a two-phase prepare (World B dial). Prepare has no command yet,
 * so there is no commandId/signal — but the Platform sends the same
 * `x-xtrape-command-origin` header on the prepare dial as on execute
 * (xtrape-docs runtime-platform/12 §4), so a prepare that renders a review
 * card can already attribute or refuse on the delivered Account context.
 */
export interface CePrepareContext {
  /** See {@link CeExecuteContext.origin}: same fact, same reading, same rules. */
  origin?: CommandOrigin;
  /**
   * Present ONLY when `prepare` is answering as the REVIEW alias (13 §9): the
   * §4.3 candidate exchange — submit the target identifiers this prepare
   * would offer and build the narrowed enum from the admitted subset that
   * comes back (review 3195). Absent on the legacy `/prepare` door.
   */
  filterResources?(candidates: string[]): Promise<string[]>;
}

export interface CeExecuteContext {
  /** Aborted on a delivered CANCEL; long actions should observe it. */
  signal?: AbortSignal;
  /** The Platform command this execution settles (World A deliveries always carry one). */
  commandId?: string;
  /**
   * The duration the command declared, in seconds — DISCLOSURE, not a budget
   * granted and reclaimable. Nothing on the Connector or the Platform ends an
   * action by elapsed time (docs#242); an action that wants a bound applies
   * one itself.
   */
  timeoutSeconds?: number;
  /**
   * The authenticated Account context the Platform delivered this command
   * under (xtrape-docs runtime-platform/12, #256): the canonical Account id
   * when the Platform could map the subject to one, and a trace id — no
   * class field, and NOT the actual originator (a Panel may be driven by an
   * AI; the Platform attests the Account, not who is at the keyboard).
   * Absent when the Platform did not send one — an action must then treat
   * it as `{}`. This is a FACT for attribution and forwarding; it is never
   * a credential, never a policy-branch input, and never taken from the
   * action's input.
   */
  origin?: CommandOrigin;
}

/**
 * The BOUNDED facade a checkpoints FACTORY receives (connector-nodejs#100,
 * review 2671): exactly the bootstrap seam the factory exists for —
 * discover the admitted execution-profile digest, publish the extractor
 * artifacts, name the instance. Deliberately NOT the raw instance credential
 * or a generic HTTP escape hatch: the Connector stays the replaceable
 * governance bridge (connector-nodejs#96), and a Widget never talks ad-hoc
 * Platform HTTP around the SDK surface. Widening this facade is a reviewed
 * SDK change, not a Widget-side workaround.
 */
export interface CheckpointFactoryContext {
  instanceId: string;
  /** The admitted execution-profile family (platform-ce#262). */
  listExecutionProfiles(): Promise<{ profiles: Array<{ digest: string; bytesJson: string; profile: Record<string, unknown>; createdAt: string }> }>;
  /** Publish one content-addressed extractor artifact (platform-ce#207; insert-only, idempotent). */
  publishResourceExtractorArtifact(input: { bytesJson: string; mediaType: string; digest?: string }): Promise<unknown>;
}

export interface ServeCeServiceHandle {
  /** The underlying registration/heartbeat/report client. */
  connector: CeServiceConnector;
  /** @deprecated Renamed to {@link ServeCeServiceHandle.connector} (connector-nodejs#79, 0.8.0 concept freeze). Same instance. */
  agent: CeServiceConnector;
  /** advertised address registered with xtrape-platform-ce */
  address: string;
  /** actual listening port */
  port: number;
  /** stop heartbeats, deregister (best-effort), and close the HTTP server */
  close(): Promise<void>;
  /**
   * Online growth of the published Checkpoint set (connector-nodejs#98): an
   * enabled library task publishes its `task.<id>` Checkpoint WITHOUT a
   * restart, the same way the live action list already grows. Validates the
   * definitions under the same rules as startup (contracts 0.8.13 edge
   * invariant included), publishes schema records first, then the immutable
   * Checkpoints, and only on success merges them into the validation set —
   * from then on a live action may bind them, and a later RE-registration's
   * descriptor rebuilds from the grown set. Insert-only platform routes make
   * a retry after partial failure idempotent. World A only: a listen-only
   * (World B) descriptor is an operator-provisioned atomic snapshot and
   * throws here — growth there is a re-provision.
   */
  publishCheckpoints(definitions: readonly CheckpointDefinition[], newSchemaRecords?: readonly CeSchemaRecordDefinition[]): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isLocalOnlyHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Read the inbound service callback token from headers (x-... or Bearer). */
function extractCallbackToken(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-xtrape-service-callback-token"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}

function requireCallbackAuthorized(req: IncomingMessage, res: ServerResponse, callbackToken?: string): boolean {
  if (!callbackToken || extractCallbackToken(req) === callbackToken) return true;
  send(res, 401, {
    code: "UNAUTHORIZED",
    message: "service callback token is missing or invalid",
    retryable: false,
  });
  return false;
}

function requireOperationalReady(res: ServerResponse, ready: boolean): boolean {
  if (ready) return true;
  send(res, 503, {
    code: "NOT_READY",
    message: "service registration and authority admission are not complete",
    retryable: true,
  });
  return false;
}

function defaultLocalAddress(host: string, port: number): string {
  if (host === "::1") return `http://[::1]:${port}`;
  return `http://${host}:${port}`;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function sendMessageError(res: ServerResponse, error: unknown): void {
  if (error instanceof CeInboundMessageValidationError) {
    send(res, 400, { code: "VALIDATION_FAILED", message: error.message, retryable: false });
    return;
  }
  const message = error instanceof Error ? error.message : "message handler failed";
  send(res, 500, { code: "HANDLER_FAILED", message, retryable: true });
}

function sendHandlerError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "action handler failed";
  send(res, 500, { code: "ACTION_FAILED", message, retryable: false });
}

export async function serveCeService(opts: ServeCeServiceOptions): Promise<ServeCeServiceHandle> {
  const host = opts.host ?? "0.0.0.0";
  if (opts.listenOnly && !opts.callbackToken) {
    // A World B service that skips the token would answer ANY caller as if it
    // were the Platform. Refuse to start instead of starting open.
    throw new Error("listenOnly requires callbackToken: the service issues the credential the Platform must present");
  }
  let connector: CeServiceConnector | undefined;
  let registered = false;
  // Binding the socket comes first because registration needs the resolved
  // callback address (including an ephemeral port). It must not make the
  // business surface executable, though. World A becomes ready only after
  // registration and, for a governed Service, atomic authority admission.
  // World B is operator-provisioned through its authenticated /descriptor and
  // has no outbound admission acknowledgement to wait for locally.
  let operationalReady = opts.listenOnly === true;
  // Authority-bearing caller objects are mutable. Copy/parse them once, then
  // use only this startup snapshot for descriptor reads and execution lookup.
  // Declare the command-origin capability (xtrape-docs runtime-platform/12,
  // #256): this SDK version parses `origin` on deliveries, so the Platform
  // may send it. Older SDKs never declare it and keep receiving the delivery
  // they always did — the feature bit is what makes the optional field safe
  // against strict consumers.
  let buildBlock = opts.manifest.build;
  if (opts.buildRoot) {
    const computed = computeBuildArtifactDigest(opts.buildRoot);
    if (buildBlock && buildBlock.artifactDigest !== computed.artifactDigest) {
      throw new Error(
        `manifest.build.artifactDigest (${buildBlock.artifactDigest}) disagrees with the identity computed over buildRoot (${computed.artifactDigest}); a self-report that contradicts the bytes admits nothing`,
      );
    }
    buildBlock = { artifactDigest: computed.artifactDigest };
  }
  const manifest = ServiceManifestSchema.parse({
    ...opts.manifest,
    ...(buildBlock ? { build: buildBlock } : {}),
    // REVIEW on the dial transport needs the per-instance lifecycle credential
    // for the §4.3 exchange; a listen-only (never registered) instance has
    // none and therefore does not advertise the capability (review 3195).
    features: { ...(opts.manifest.features ?? {}), [COMMAND_ORIGIN_FEATURE]: true, ...(opts.listenOnly ? {} : { [REVIEW_FEATURE]: true }) },
  });
  const schemaRecords = (opts.schemaRecords ?? []).map((record) => ({ ...record }));
  const schemaDigests = new Set<string>();
  for (const record of schemaRecords) {
    const computed = `sha256:${createHash("sha256").update(record.bytesJson, "utf8").digest("hex")}`;
    if (record.digest !== computed) throw new Error(`schema record digest mismatch: declared ${record.digest}, computed ${computed}`);
    if (schemaDigests.has(record.digest)) throw new Error(`duplicate schema record: ${record.digest}`);
    schemaDigests.add(record.digest);
  }
  const checkpointsFactory = typeof opts.checkpoints === "function" ? opts.checkpoints : undefined;
  if (checkpointsFactory && opts.listenOnly === true) {
    throw new Error("a checkpoints FACTORY needs a registration (its context is the instance credential); a listen-only (World B) service passes the plain array");
  }
  const checkpoints: CheckpointDefinition[] = [];
  const checkpointKeys = new Set<string>();
  const definitionByKey = new Map<string, CheckpointDefinition>();
  const adoptCheckpoints = (candidates: readonly unknown[]): void => {
    for (const candidate of candidates) {
      const definition = CheckpointDefinitionSchema.parse(candidate);
      if (definition.id.serviceId !== manifest.service.id) {
        throw new Error(
          `checkpoint ${checkpointVersionKey(definition.id)} does not belong to manifest Service ${manifest.service.id}`,
        );
      }
      const key = checkpointVersionKey(definition.id);
      if (checkpointKeys.has(key)) throw new Error(`duplicate Checkpoint definition: ${key}`);
      for (const [field, ref] of schemaRefsOf(definition)) {
        if (!schemaDigests.has(ref.schemaRecord)) {
          throw new Error(`${key} ${field} references schema record ${ref.schemaRecord}, which is absent from this Service descriptor`);
        }
      }
      checkpoints.push(definition);
      checkpointKeys.add(key);
      definitionByKey.set(key, definition);
    }
  };
  if (!checkpointsFactory) adoptCheckpoints((opts.checkpoints as CheckpointDefinition[] | undefined) ?? []);
  // The action list is read LIVE from the caller's array (by reference): a
  // Service whose catalog changes at runtime — linux-ops-widget's task
  // library grows online, and a governed content version applied by its poll
  // rebuilds its ops entries in place — needs the Platform's next
  // GET /actions and the next execute lookup to see the change without a
  // re-registration or restart. 0.8.2 snapshotted the array at startup while
  // adding the authority-descriptor validation, which silently froze such
  // catalogs (m1-local zero-shot, 2026-08-18). So: the validation runs at
  // startup on the initial contents (throws, as before) and again on every
  // read; a live change that fails validation is refused by keeping the last
  // valid view and reporting once, never by publishing half a catalog.
  const actionSource = opts.actions ?? [];
  const normalizeActions = () =>
    actionSource.map((action) => ({
      ...action,
      ...(action.inputSchema === undefined ? {} : { inputSchema: structuredClone(action.inputSchema) }),
      ...(action.checkpoint === undefined ? {} : { checkpoint: CheckpointVersionIdSchema.parse(action.checkpoint) }),
    }));
  /**
   * Two validation modes (review 2664, docs#228 D5):
   *
   * - `startup` — the descriptor about to be PUBLISHED must be the atomic 1:1
   *   snapshot Platform admission requires: every Checkpoint bound, every
   *   action (when checkpoints exist) binding one.
   * - `live`    — the running catalog is dispatchability/liveness EVIDENCE,
   *   and an Action legitimately DISAPPEARING is exactly what D5 models: the
   *   Platform resolves the affected Checkpoint to UNDISPATCHABLE until the
   *   exact reference matches again. So the completeness rules are NOT
   *   enforced live — a removal/rename must flow through to the Platform,
   *   never be masked by serving the last snapshot as if nothing vanished.
   *   The CONSISTENCY rules still hold live (duplicate names, binding an
   *   unpublished Checkpoint, a disagreeing edge): those describe a broken
   *   catalog, not a smaller one, and keeping the last valid view for them is
   *   the protective behavior the live path exists for.
   */
  const validateActions = (candidates: ReturnType<typeof normalizeActions>, mode: "startup" | "live"): void => {
    const actionCheckpointKeys = new Set<string>();
    const actionNames = new Set<string>();
    for (const action of candidates) {
      if (actionNames.has(action.name)) throw new Error(`duplicate Action name: ${action.name}`);
      actionNames.add(action.name);
      if (mode === "startup" && checkpoints.length > 0 && action.checkpoint === undefined) {
        throw new Error(`action ${action.name} must bind an immutable Checkpoint`);
      }
      if (action.checkpoint !== undefined) {
        const key = checkpointVersionKey(action.checkpoint);
        if (!checkpointKeys.has(key)) throw new Error(`action ${action.name} binds unpublished Checkpoint ${key}`);
        if (actionCheckpointKeys.has(key)) throw new Error(`Checkpoint ${key} is bound by more than one Action`);
        actionCheckpointKeys.add(key);
        // arch/19 §3.1 rule 4 (contracts 0.8.13, docs#228 D1): the immutable
        // definition's OWN Action edge is the authority, and both ends must
        // agree — the Platform's admission refuses the disagreement, so the
        // SDK fails the same way BEFORE publishing rather than shipping a
        // descriptor the Platform will bounce.
        const declared = definitionByKey.get(key)?.action?.actionId;
        if (declared !== action.name) {
          throw new Error(
            `Checkpoint ${key} declares Action ${declared ?? "(none)"} but is bound by Action ${action.name} — the two ends of the edge disagree (docs#228 D1)`,
          );
        }
      }
    }
    if (mode === "startup") {
      for (const key of checkpointKeys) {
        if (!actionCheckpointKeys.has(key)) throw new Error(`published Checkpoint ${key} is not bound by an Action`);
      }
    }
  };
  let actions = normalizeActions();
  // With a checkpoints FACTORY the definitions do not exist yet: the startup
  // completeness validation runs after the factory resolves (below), still
  // BEFORE the descriptor is published and before anything serves.
  if (!checkpointsFactory) validateActions(actions, "startup");
  let liveActionsRefused = false;
  /** The current, validated view of the caller's live action list. */
  const liveActions = () => {
    try {
      const next = normalizeActions();
      validateActions(next, "live");
      actions = next;
      liveActionsRefused = false;
    } catch (error) {
      if (!liveActionsRefused) {
        liveActionsRefused = true;
        process.stderr.write(`serveCeService: live action list refused (${error instanceof Error ? error.message : String(error)}); serving the last valid catalog\n`);
      }
    }
    return actions;
  };

  const actionCatalog = () =>
    liveActions().map((action) => ({
      name: action.name,
      label: action.label,
      description: action.description,
      category: action.category,
      order: action.order,
      // Legacy catalog: a two-phase Action — `prepare` OR a direct `review` —
      // keeps the closed-door marker so an older Platform never dispatches it
      // as an ordinary single-phase Action (review 3195).
      requiresPrepare: typeof action.prepare === "function" || typeof action.review === "function" ? true : undefined,
      inputSchema: action.inputSchema,
      // Only a positive integer reaches the catalog (connector-nodejs#76): a
      // fractional or non-positive budget is not a budget, and dropping it
      // here keeps the wire clean: a malformed disclosure is simply not sent
      // (the Platform neither clamps nor rejects a well-formed one — it is
      // reminder metadata carried verbatim, #106/#189).
      timeoutSeconds:
        typeof action.timeoutSeconds === "number" && Number.isInteger(action.timeoutSeconds) && action.timeoutSeconds > 0
          ? action.timeoutSeconds
          : undefined,
      checkpoint: action.checkpoint,
    }));
  const authorityDescriptor = (): CeAuthorityDescriptor => ({
    manifest,
    actions: actionCatalog(),
    schemaRecords: schemaRecords.map((record) => ({ ...record })),
    checkpoints: checkpoints.map((definition) => structuredClone(definition)),
  });

  /**
   * connector-nodejs#98 — see the handle JSDoc. SERIAL mutation boundary
   * (review 2669): every growth call runs the whole
   * preflight → durable publish → local merge sequence inside one promise
   * chain, and the preflight reads the LOCAL SETS AS THEY ARE AT ACQUISITION
   * TIME — a concurrent identical growth therefore re-preflights against the
   * winner's merged snapshot and is refused as a duplicate BEFORE any durable
   * call, and an intra-batch duplicate can never produce the
   * `checkpoints=[A,A] / checkpointKeys={A}` divergence that would make the
   * next re-registration descriptor invalid.
   */
  let growthChain: Promise<void> = Promise.resolve();
  const growCheckpoints = (
    definitions: readonly CheckpointDefinition[],
    newSchemaRecords: readonly CeSchemaRecordDefinition[] = [],
  ): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!connector) throw new Error("publishCheckpoints: a listen-only (World B) descriptor is an operator-provisioned atomic snapshot; growth is a re-provision");
      // --- schema records: digest integrity, batch uniqueness, idempotent skip ---
      const batchDigests = new Set<string>();
      const addedRecords: CeSchemaRecordDefinition[] = [];
      for (const record of newSchemaRecords) {
        const computed = `sha256:${createHash("sha256").update(record.bytesJson, "utf8").digest("hex")}`;
        if (record.digest !== computed) throw new Error(`schema record digest mismatch: declared ${record.digest}, computed ${computed}`);
        if (batchDigests.has(record.digest)) throw new Error(`duplicate schema record in this batch: ${record.digest}`);
        batchDigests.add(record.digest);
        // Already-known digest: content-addressed identity (the integrity
        // check above pins bytes to digest), so this is an IDEMPOTENT SKIP —
        // no second durable publish, no second local row.
        if (schemaDigests.has(record.digest)) continue;
        addedRecords.push({ ...record });
      }
      const knownDigests = new Set([...schemaDigests, ...addedRecords.map((r) => r.digest)]);
      // --- checkpoints: batch uniqueness AND freshness against the local set ---
      const parsed = definitions.map((candidate) => CheckpointDefinitionSchema.parse(candidate));
      const batchKeys = new Set<string>();
      for (const definition of parsed) {
        if (definition.id.serviceId !== manifest.service.id) {
          throw new Error(`checkpoint ${checkpointVersionKey(definition.id)} does not belong to manifest Service ${manifest.service.id}`);
        }
        const key = checkpointVersionKey(definition.id);
        if (batchKeys.has(key)) throw new Error(`duplicate Checkpoint definition in this batch: ${key}`);
        batchKeys.add(key);
        if (checkpointKeys.has(key)) throw new Error(`duplicate Checkpoint definition: ${key}`);
        for (const [field, ref] of schemaRefsOf(definition)) {
          if (!knownDigests.has(ref.schemaRecord)) {
            throw new Error(`${key} ${field} references schema record ${ref.schemaRecord}, which is absent from this Service descriptor`);
          }
        }
      }
      // Durable first, local merge ONLY on success: a failure leaves the
      // validation set untouched and the insert-only routes make retry safe.
      if (addedRecords.length > 0) await connector.publishSchemaRecords(addedRecords);
      if (parsed.length > 0) await connector.publishCheckpoints(parsed);
      for (const record of addedRecords) {
        schemaRecords.push(record);
        schemaDigests.add(record.digest);
      }
      for (const definition of parsed) {
        const key = checkpointVersionKey(definition.id);
        checkpoints.push(definition);
        checkpointKeys.add(key);
        definitionByKey.set(key, definition);
      }
    };
    // Chain regardless of the predecessor's outcome; surface only OUR result.
    const outcome = growthChain.then(run, run);
    growthChain = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  };
  // Inbound callback credential, in precedence order: the Platform-minted
  // per-instance token (adopted at registration, rotated by re-registration)
  // over the statically configured one (docs#122).
  /**
   * The credential inbound calls must present, resolved PER REQUEST from the
   * connector's latest registration (review #71 blocker 2): re-registering rotates
   * the minted token, and a value captured in this closure at first
   * registration would keep accepting the retired credential and rejecting
   * the current one. listen-only mode has no registrations; the service-issued
   * token from options is the sole credential.
   */
  const expectedCallbackToken = (): string | undefined => connector?.currentCallbackToken ?? opts.callbackToken;
  let transportFatalError: Error | undefined;

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          if (transportFatalError) {
            send(res, 503, {
              ok: false,
              service: manifest.service.id,
              code: "TRANSPORT_FATAL",
            });
          } else {
            send(res, 200, { ok: true, service: manifest.service.id });
          }
          return;
        }
        if (req.method === "POST" && req.url === "/messages") {
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!connector) throw new Error("ready service has no connector");
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          const raw = await readBody(req);
          let payload: unknown;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch (error) {
            send(res, 400, {
              code: "VALIDATION_FAILED",
              message: error instanceof Error ? error.message : "invalid JSON request body",
              retryable: false,
            });
            return;
          }
          const reply = await connector.handleMessage(payload, opts.handler);
          send(res, 200, reply);
          return;
        }
        if (req.method === "GET" && req.url === "/actions") {
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          send(res, 200, actionCatalog());
          return;
        }
        if (req.method === "GET" && req.url === "/descriptor") {
          // World B must expose this authenticated provisioning probe before
          // Platform admission; World A publishes the same snapshot outbound
          // and does not expose it until that admission has succeeded.
          if (!opts.listenOnly && !requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          // A legacy Service has no governed authority descriptor. 404 is an
          // explicit absence signal so a compatible Platform may probe the
          // legacy /actions surface. Once any Checkpoint exists, /descriptor
          // is authoritative: malformed governed data must never downgrade.
          if (checkpoints.length === 0) {
            send(res, 404, { code: "AUTHORITY_DESCRIPTOR_NOT_AVAILABLE", message: "service has no governed authority descriptor", retryable: false });
            return;
          }
          // One authenticated snapshot prevents World B provisioning from
          // combining a manifest, catalog and Checkpoint set observed at
          // different deployments.
          send(res, 200, {
            ...authorityDescriptor(),
          });
          return;
        }
        const prepareMatch = req.url?.match(/^\/actions\/([^/]+)\/prepare$/);
        if (req.method === "POST" && prepareMatch) {
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          const name = decodeURIComponent(prepareMatch[1]);
          const action = liveActions().find((candidate) => candidate.name === name);
          if (!action) {
            send(res, 404, { code: "ACTION_NOT_FOUND", message: `action ${name} not found`, retryable: false });
            return;
          }
          if (typeof action.prepare !== "function") {
            send(res, 400, { code: "ACTION_NOT_PREPARABLE", message: `action ${name} has no prepare step`, retryable: false });
            return;
          }
          const raw = await readBody(req);
          let payload: unknown;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch (error) {
            send(res, 400, {
              code: "VALIDATION_FAILED",
              message: error instanceof Error ? error.message : "invalid JSON request body",
              retryable: false,
            });
            return;
          }
          // Same Platform-set header as execute (12-command-origin §4);
          // malformed = absent, never an error, and never from the body.
          const prepareOrigin = parseOriginHeader(req.headers[COMMAND_ORIGIN_HEADER]);
          try {
            send(res, 200, (await action.prepare(payload, prepareOrigin ? { origin: prepareOrigin } : {})) ?? {});
          } catch (error) {
            sendHandlerError(res, error);
          }
          return;
        }
        // runtime-platform/13 §9: the dial transport's REVIEW door (declared
        // by REVIEW_FEATURE when this instance is registered). A REVIEW is a
        // Command (13 §3), so this door runs ONLY under a command id and under
        // the execute lifecycle (reviews 3195/3196): admitted through the
        // registry — a CANCEL that arrived first wins, a CANCEL that arrives
        // while the handler runs discards the late result, and a retry of the
        // same command id recovers the frozen `next` kept on the tombstone
        // (13 §5.5), never a second card. The commandless compatibility
        // surface is the legacy `/prepare` door, not this one.
        const reviewMatch = req.url?.match(/^\/actions\/([^/]+)\/review$/);
        if (req.method === "POST" && reviewMatch) {
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          const name = decodeURIComponent(reviewMatch[1]);
          const commandIdHeader = req.headers["x-xtrape-command-id"];
          const commandId = typeof commandIdHeader === "string" && commandIdHeader !== "" ? commandIdHeader : undefined;
          if (!commandId) {
            send(res, 400, { code: "COMMAND_ID_REQUIRED", message: "a review is a Command (runtime-platform/13 §3): POST /actions/:name/review needs x-xtrape-command-id", retryable: false });
            return;
          }
          const admission = commands.beginExecution(commandId);
          if (!admission.admit) {
            if (admission.reason === "already-settled" && admission.frozen !== undefined) {
              send(res, 200, { next: admission.frozen });
              return;
            }
            const cancelled = admission.reason === "cancelled-before-start";
            send(res, 409, {
              code: cancelled ? "CANCELLED" : "COMMAND_IN_FLIGHT",
              message: cancelled ? "review cancelled by the server before it began" : `review ${commandId} has already been handled here`,
              retryable: false,
            });
            return;
          }
          const reviewAbort = admission.abort;
          const settleCancelled = (): void => {
            commands.settleWithoutReport(commandId, "FAILED");
            send(res, 409, { code: "CANCELLED", failureReason: "CANCELLED", message: "review cancelled by the server", retryable: false });
          };
          const action = liveActions().find((candidate) => candidate.name === name);
          if (!action) {
            commands.settleWithoutReport(commandId, "FAILED");
            send(res, 404, { code: "ACTION_NOT_FOUND", message: `action ${name} not found`, retryable: false });
            return;
          }
          const raw = await readBody(req);
          if (reviewAbort.signal.aborted) {
            settleCancelled();
            return;
          }
          let payload: unknown;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch (error) {
            commands.settleWithoutReport(commandId, "FAILED");
            send(res, 400, { code: "VALIDATION_FAILED", message: error instanceof Error ? error.message : "invalid JSON request body", retryable: false });
            return;
          }
          const reviewOrigin = parseOriginHeader(req.headers[COMMAND_ORIGIN_HEADER]);
          try {
            const next = await reviewNextOf(action, payload, {
              commandId,
              signal: reviewAbort.signal,
              ...(reviewOrigin ? { origin: reviewOrigin } : {}),
              filterResources: (candidates) => {
                // The exchange needs the per-instance lifecycle credential (a
                // registered instance); a listen-only instance has none and
                // never advertised REVIEW.
                if (!connector || opts.listenOnly) return Promise.reject(Object.assign(new Error("the candidate exchange needs a registered instance"), { code: "REVIEW_EXCHANGE_UNAVAILABLE" }));
                return connector.filterCandidateResources(commandId, candidates);
              },
            });
            if (reviewAbort.signal.aborted) {
              // The accepted cancel wins over a late result (review 3196).
              settleCancelled();
              return;
            }
            commands.settleWithoutReport(commandId, "COMPLETED", next as unknown as Record<string, unknown>);
            send(res, 200, { next });
          } catch (error) {
            if (reviewAbort.signal.aborted) {
              settleCancelled();
              return;
            }
            commands.settleWithoutReport(commandId, "FAILED");
            const code = (error as { code?: string }).code;
            if (code === "ACTION_NOT_REVIEWABLE") send(res, 400, { code, message: `action ${name} has no review step`, retryable: false });
            else sendHandlerError(res, error);
          }
          return;
        }
        const executeMatch = req.url?.match(/^\/actions\/([^/]+)\/execute$/);
        const cancelMatch = req.method === "POST" && /^\/commands\/[^/]+\/cancel$/.test(req.url ?? "");
        if (cancelMatch) {
          // World B cancel (`POST {route}/commands/:id/cancel`). The Platform
          // has always dialled this; this listener never implemented it, so an
          // explicit cancel — the ONLY thing that ends a running action now
          // that nothing ends one by time — could not reach a World B action
          // at all (review 2178).
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          const commandId = decodeURIComponent((req.url ?? "").split("/")[2] ?? "");
          // The registry answers this, including the case a presence-only map
          // could not: a cancel that arrives BEFORE its execute is recorded, so
          // the execute is refused when it turns up rather than running anyway
          // and being reported as cancelled after the fact (review 2185).
          const { outcome, terminalStatus } = commands.cancel(commandId);
          // The frozen `CommandCancelResponse` is a discriminated union whose
          // CANCELLING arm carries `status: "RUNNING"` and whose
          // ALREADY_TERMINAL arm carries a terminal status. Answering with
          // outcome alone left the Platform unable to validate what it had
          // received, which is exactly what it must do before recording a
          // cancel as delivered (review 2187).
          send(
            res,
            200,
            outcome === "CANCELLING"
              ? { contractVersion: CE_CONTRACT_VERSION, commandId, outcome, status: "RUNNING" }
              // How it ended, when this process still knows. A command that
              // COMPLETED must not be described as FAILED just because the
              // union needs a terminal status in this arm.
              : { contractVersion: CE_CONTRACT_VERSION, commandId, outcome, status: terminalStatus ?? "FAILED" },
          );
          return;
        }
        if (req.method === "POST" && executeMatch) {
          if (!requireOperationalReady(res, operationalReady)) return;
          if (!requireCallbackAuthorized(req, res, expectedCallbackToken())) return;
          const name = decodeURIComponent(executeMatch[1]);
          // Admission FIRST for any push that names a command — before the
          // action is even looked up (review 2207, the World B half of review
          // 2205). Classifying pre-admission answered 404 ACTION_NOT_FOUND for
          // a command the registry knew better about: one whose CANCEL had
          // already arrived (and been answered CANCELLING), or one already
          // running, settled, or holding an unreported outcome here. Only a
          // genuinely admitted command is classified at all.
          const commandIdRaw = req.headers["x-xtrape-command-id"];
          const commandIdHeader = Array.isArray(commandIdRaw) ? commandIdRaw[0] : commandIdRaw;
          const tracked = typeof commandIdHeader === "string" && commandIdHeader.length > 0;
          const commandId = tracked ? (commandIdHeader as string) : "";
          // World B: the origin rides a Platform-set header on the dial
          // (xtrape-docs runtime-platform/12 §4) — the body stays a strict
          // CommandDispatchRequest, so nothing a caller can put in a body
          // becomes an origin. Malformed = absent = `{}` for the action.
          const origin = parseOriginHeader(req.headers[COMMAND_ORIGIN_HEADER]);
          const canReport = Boolean(connector) && !opts.listenOnly;
          let admittedAbort: AbortController | undefined;
          if (tracked) {
            // A repeated push of the same commandId — a Platform retry, a
            // reconnect — must not start a second execution. Re-running a
            // side-effecting action is bad enough; overwriting the map entry
            // would also orphan the first run's abort handle, so a later cancel
            // would stop only the newcomer while the original ran on
            // unstoppable (review 2181).
            const admission = commands.beginExecution(commandId);
            if (!admission.admit) {
              if (canReport && connector) {
                // Registered push: ack the same 202 and let the run (or the
                // owed report) that owns the command settle it.
                send(res, 202, { contractVersion: CE_CONTRACT_VERSION, status: "RUNNING", commandId });
                if (admission.reason === "cancelled-before-start") {
                  // Claim the report first: the registry no longer settles
                  // this case itself, so a failed delivery keeps the CANCELLED
                  // outcome owed instead of dropping it (review 2194).
                  const owed = { status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED", errorMessage: "command cancelled by the server before execution began" } as const;
                  commands.beginReporting(commandId, owed);
                  void reportOwed(connector, commandId, owed);
                } else if (admission.reason === "replay-outcome") {
                  // Already executed; replay what the Platform has not accepted.
                  void reportOwed(connector, commandId, admission.outcome as Parameters<CeServiceConnector["reportCommandResult"]>[1]);
                }
                return;
              }
              // The synchronous channel: the response IS the answer. The
              // status distinguishes a cancelled command from a mere
              // collision, so the caller is not told the wrong story.
              const cancelled = admission.reason === "cancelled-before-start";
              send(res, 409, {
                code: cancelled ? "CANCELLED" : "COMMAND_IN_FLIGHT",
                message: cancelled
                  ? "command cancelled by the server before execution began"
                  : `command ${commandId} has already been handled here`,
                retryable: false,
              });
              return;
            }
            admittedAbort = admission.abort;
          }
          const action = liveActions().find((candidate) => candidate.name === name);
          if (!action) {
            // The command (if any) is ADMITTED, so this refusal is a terminal
            // outcome and must not leak an `executing` registration.
            if (tracked && canReport && connector) {
              // Same lifecycle as every terminal outcome (review 2203): claim,
              // report through the owed path, carry a racing cancel's cause.
              send(res, 202, { contractVersion: CE_CONTRACT_VERSION, status: "RUNNING", commandId });
              const owed = { status: "FAILED", errorCode: "ACTION_NOT_FOUND", errorMessage: `action ${name} not found` } as const;
              const cause = commands.beginReporting(commandId, owed);
              void reportOwed(connector, commandId, cause !== undefined ? causeOutcome(cause) : owed);
              return;
            }
            // Synchronous channel: the 404 IS the report.
            if (tracked) commands.settleWithoutReport(commandId, "FAILED");
            send(res, 404, { code: "ACTION_NOT_FOUND", message: `action ${name} not found`, retryable: false });
            return;
          }
          const raw = await readBody(req);
          // Re-confirm the admitted execution AFTER the only await between
          // admission and the business call (review 2208). Admission moved
          // ahead of the body read to fix 2207, which opened this window: a
          // CANCEL landing while the body was in flight aborted the signal
          // and was answered CANCELLING — and the handler then parsed,
          // classified, and called action.execute() anyway, checking the
          // signal only afterwards. An action that never looks at its signal
          // produced a business side effect AFTER the cancel was accepted;
          // and a body that then failed to parse settled VALIDATION_FAILED
          // straight over the established cancellation cause. Once the
          // execution is stopped, nothing below may run: the registry's cause
          // decides the terminal outcome.
          if (tracked && admittedAbort?.signal.aborted) {
            const fallback = { status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED", errorMessage: "command cancelled by the server before execution began" } as const;
            const cause = commands.beginReporting(commandId, fallback);
            const owed = cause !== undefined ? causeOutcome(cause) : fallback;
            if (canReport && connector) {
              send(res, 202, { contractVersion: CE_CONTRACT_VERSION, status: "RUNNING", commandId });
              void reportOwed(connector, commandId, owed);
              return;
            }
            // Synchronous channel: the response is the report, as in the
            // execute-time cancel path.
            send(res, 409, { code: "CANCELLED", failureReason: "CANCELLED", message: "command cancelled by the server", retryable: false });
            commands.settleWithoutReport(commandId, "FAILED");
            return;
          }
          let payload: unknown;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch (error) {
            // The 400 IS the report, on either channel: the dialer is reading
            // this response right now and classifies the forward failure.
            if (tracked) commands.settleWithoutReport(commandId, "FAILED");
            send(res, 400, {
              code: "VALIDATION_FAILED",
              message: error instanceof Error ? error.message : "invalid JSON request body",
              retryable: false,
            });
            return;
          }
          if (tracked && canReport && connector && admittedAbort) {
            // ALWAYS async when the push carries a commandId and a report path
            // exists — not only for actions that set `async: true` (review 2178).
            //
            // The transport is uniformly async (docs/09 §6), and the
            // synchronous branch could not honour that: an action outliving the
            // Platform's bounded forward window left the Platform's HTTP request
            // abandoned while the action kept going, so the result was
            // eventually written to a response nobody was reading and the
            // command stayed RUNNING for ever — with nothing left to settle it
            // by time, and rightly so (docs#242). An action that waits on a
            // person through ask() crosses that window as a matter of course.
            //
            // Ack RUNNING now, run in the background, report the outcome with
            // the per-instance access token.
            const reporter = connector;
            const pushAbort = admittedAbort;
            send(res, 202, { contractVersion: CE_CONTRACT_VERSION, status: "RUNNING", commandId });
            void (async () => {
              let outcome: { status: "COMPLETED" | "FAILED"; result?: Record<string, unknown>; errorCode?: string; errorMessage?: string };
              try {
                // The commandId is right here in the header — passing it makes
                // dedupe and cancel a transport-independent invariant instead
                // of a World A privilege (review 2175). The abort signal is the
                // admission's: `POST /commands/:id/cancel` (review 2178) aborts
                // exactly this handle, and an action written against the
                // context does not need to know which transport carried it.
                const result = await action.execute(payload, { commandId, signal: pushAbort.signal, ...(origin ? { origin } : {}) });
                if (pushAbort.signal.aborted) throw new Error("aborted");
                outcome = {
                  status: "COMPLETED",
                  ...(result !== undefined && result !== null && typeof result === "object" && !Array.isArray(result)
                    ? { result: result as Record<string, unknown> }
                    : result !== undefined
                      ? { result: { value: result } }
                      : {}),
                };
              } catch (error) {
                outcome = {
                  status: "FAILED",
                  errorCode: "ACTION_FAILED",
                  errorMessage: error instanceof Error ? error.message : "action handler failed",
                };
              }
              // Tracked across the report: a terminal outcome in flight is work
              // this process still owes, and a drain that ignored it could
              // deregister and lose it.
              const cause = commands.beginReporting(commandId, outcome);
              if (cause !== undefined) outcome = causeOutcome(cause);
              await reportOwed(reporter, commandId, outcome);
            })();
            return;
          }
          // The synchronous branch (listen-only, or a push with no report
          // channel). It registered in the command registry above too: without
          // that, a cancel for an action still running here found nothing and
          // was answered ALREADY_TERMINAL — telling the Platform a cancel had
          // been applied to a command that was never told about it, and
          // recording an undelivered cancel as delivered (review 2181).
          const syncTracked = tracked;
          const syncAbort = admittedAbort ?? new AbortController();
          let syncOutcome: "COMPLETED" | "FAILED" = "FAILED";
          try {
            // Same reason: when the push carried a commandId, the action sees
            // it whichever branch runs.
            const out = await action.execute(payload, {
              ...(syncTracked ? { commandId } : {}),
              signal: syncAbort.signal,
              ...(origin ? { origin } : {}),
            });
            if (syncAbort.signal.aborted) throw new Error("aborted");
            send(res, 200, out);
            syncOutcome = "COMPLETED";
          } catch (error) {
            // The registry knows whether a cancel caused this, so the answer
            // classifies the same way every other transport does.
            const cause = syncTracked ? commands.beginReporting(commandId, { status: "FAILED" }) : undefined;
            if (cause === "CANCELLED") {
              send(res, 409, { code: "CANCELLED", failureReason: "CANCELLED", message: "command cancelled by the server", retryable: false });
            } else {
              sendHandlerError(res, error);
            }
          } finally {
            // Nothing is owed once the caller holds the answer: on this
            // transport the HTTP response IS the report.
            if (syncTracked) commands.settleWithoutReport(commandId, syncOutcome);
          }
          return;
        }
        send(res, 404, { code: "NOT_FOUND", message: "not found", retryable: false });
      } catch (e) {
        sendMessageError(res, e);
      }
    })();
  });

  await listen(server, opts.port ?? 0, host);
  const info = server.address();
  const port = typeof info === "object" && info ? info.port : (opts.port ?? 0);
  // listen-only gets NO wildcard exemption (review #71): 0.0.0.0/:: is a bind
  // address, not one the Platform can dial back — handing it to the operator as
  // "the address" would be recorded verbatim in platform-ce and every dial would
  // fail. Only genuinely local hosts are derivable; everything else must be
  // stated explicitly, in both modes.
  const address = opts.address ?? (isLocalOnlyHost(host) ? defaultLocalAddress(host, port) : undefined);

  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      `serveCeService requires an explicit address when host=${host}. ` +
        `For deployed/containerized use, pass a reachable callback URL such as http://demo-service:8080` +
        (opts.listenOnly ? " — in listen-only mode this is the address the operator records in platform-ce." : "."),
    );
  }

  let pollLoop: CeLongPollLoop | undefined;
  let reportRetryTimer: ReturnType<typeof setInterval> | undefined;
  // What this process knows about each command it has been asked to run, on
  // every transport. See `./command-registry.ts` for the states and why a bare
  // "is it running" map could not express them. There is no TIMEOUT cause —
  // the Connector never ends an action by elapsed time (docs#242).
  const commands = new CommandRegistry();

  async function runDeliveredExecute(reporter: CeServiceConnector, command: Extract<StreamDelivery, { kind: "COMMAND" }>["command"]): Promise<void> {
    // Admission comes FIRST — before any classification of the command
    // (review 2205). Classifying pre-admission put ACTION_NOT_FOUND and the
    // two-phase refusal ahead of what the registry already knows: a CANCEL
    // that had arrived first had recorded cancelled-before-start, and the
    // refusal's beginReporting overwrote it — reporting the command as
    // ACTION_NOT_FOUND when the truthful outcome was FAILED(CANCELLED).
    // Everything a redelivery or an early cancel implies is decided here; only
    // a genuinely admitted command goes on to be classified at all.
    const admission = commands.beginExecution(command.commandId);
    if (!admission.admit) {
      if (admission.reason === "cancelled-before-start") {
        // Claim before reporting, for the same reason as the push path: a
        // failed delivery must keep this outcome owed (review 2194).
        const owed = { status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED", errorMessage: "command cancelled by the server before execution began" } as const;
        commands.beginReporting(command.commandId, owed);
        await reportOwed(reporter, command.commandId, owed);
      } else if (admission.reason === "replay-outcome") {
        // The action already ran; only the Platform's knowledge is missing.
        // This redelivery is the chance to report it again — never to re-run.
        await reportOwed(reporter, command.commandId, admission.outcome as Parameters<CeServiceConnector["reportCommandResult"]>[1]);
      }
      return;
    }
    const action = liveActions().find((candidate) => candidate.name === command.actionName);
    // A refusal of an ADMITTED command is a terminal outcome like any other:
    // the COMMAND was already acked off the stream, so a lost report leaves
    // the Platform RUNNING for ever. beginReporting claims the delivery — a
    // failed report goes unreported and the retry owner re-sends it (review
    // 2203) — and carries any stop cause the execution picked up, so a cancel
    // racing this narrow window still reports as CANCELLED.
    const refuse = async (outcome: Parameters<CeServiceConnector["reportCommandResult"]>[1]) => {
      const cause = commands.beginReporting(command.commandId, outcome as Record<string, unknown>);
      await reportOwed(reporter, command.commandId, cause !== undefined ? causeOutcome(cause) : outcome);
    };
    if (!action) {
      await refuse({ status: "FAILED", errorCode: "ACTION_NOT_FOUND", errorMessage: `action ${command.actionName} not found` });
      return;
    }
    // runtime-platform/13: an EXECUTE of a two-phase action is legal on this
    // transport — the Platform only dispatches it after an ADMITTED review of
    // the same Checkpoint (reviewProven), and the action verifies the review
    // binding it sealed. The former PREPARE_UNSUPPORTED_ON_LONG_POLL refusal
    // guarded a door that no Platform opens without that review.
    const abort = admission.abort;
    // NO client-side deadline. `timeoutSeconds` is disclosure — the action may
    // legitimately run for hours, including one waiting on a person through
    // ask() — and a Connector-side clock that aborted it would be the exact
    // "terminate business by elapsed time" the platform no longer does
    // (docs#242, xtrape-platform-ce#187). What ends a running action is the
    // action finishing, or an explicit CANCEL the platform relayed. The value
    // is still passed to the action as disclosure, for a task that chooses to
    // bound ITSELF.
    let outcome: Parameters<CeServiceConnector["reportCommandResult"]>[1];
    try {
      const raced = await Promise.race([
        Promise.resolve(
          action.execute(command.input ?? {}, {
            signal: abort.signal,
            commandId: command.commandId,
            timeoutSeconds: command.timeoutSeconds,
            ...(command.origin !== undefined ? { origin: command.origin } : {}),
          }),
        ),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
      if (abort.signal.aborted) throw new Error("aborted");
      const result =
        raced !== undefined && raced !== null && typeof raced === "object" && !Array.isArray(raced)
          ? (raced as Record<string, unknown>)
          : raced !== undefined
            ? { value: raced }
            : undefined;
      outcome = { status: "COMPLETED", ...(result !== undefined ? { result } : {}) };
    } catch (error) {
      outcome = terminalOutcome(commands.phaseOf(command.commandId) === undefined ? undefined : undefined, error);
    }
    // The command stays tracked across the report: a terminal outcome in
    // flight is work this process still owes, and a drain that ignored it
    // could deregister and lose it (review 2185).
    const cause = commands.beginReporting(command.commandId, outcome);
    if (cause !== undefined) outcome = causeOutcome(cause);
    await reportOwed(reporter, command.commandId, outcome);
  }

  /** The review answer of an action: its own `review`, or the 13 §9 alias over `prepare`. Validated as the contracts envelope. */
  async function reviewNextOf(action: CeServiceActionDefinition, input: unknown, context: CeReviewContext): Promise<ReviewNext> {
    let next: ReviewNext;
    if (typeof action.review === "function") {
      next = await action.review(input ?? {}, context);
    } else if (typeof action.prepare === "function") {
      const prepared = (await action.prepare(input ?? {}, { ...(context.origin ? { origin: context.origin } : {}), filterResources: context.filterResources })) ?? {};
      next = {
        inputSchema: prepared.inputSchema ?? action.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
        initialPayload: prepared.initialPayload ?? {},
        currentState: prepared.currentState ?? {},
      };
    } else {
      throw Object.assign(new Error(`action ${action.name} has no review step`), { code: "ACTION_NOT_REVIEWABLE" });
    }
    return ReviewCommandResultSchema.parse({ next }).next;
  }

  /**
   * A delivered REVIEW command (runtime-platform/13 §3): admitted like an
   * execute (a cancel that beat it still wins), answered with `{ next }` on
   * the report path, never run as an execute. No side effect is the action's
   * contract; a thrown error is a FAILED review with its own code.
   */
  async function runDeliveredReview(reporter: CeServiceConnector, command: Extract<StreamDelivery, { kind: "COMMAND" }>["command"]): Promise<void> {
    const admission = commands.beginExecution(command.commandId);
    if (!admission.admit) {
      if (admission.reason === "cancelled-before-start") {
        const owed = { status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED", errorMessage: "review cancelled by the server before it began" } as const;
        commands.beginReporting(command.commandId, owed);
        await reportOwed(reporter, command.commandId, owed);
      } else if (admission.reason === "replay-outcome") {
        await reportOwed(reporter, command.commandId, admission.outcome as Parameters<CeServiceConnector["reportCommandResult"]>[1]);
      }
      return;
    }
    const action = liveActions().find((candidate) => candidate.name === command.actionName);
    let outcome: Parameters<CeServiceConnector["reportCommandResult"]>[1];
    if (!action) {
      outcome = { status: "FAILED", errorCode: "ACTION_NOT_FOUND", errorMessage: `action ${command.actionName} not found` };
    } else {
      try {
        const next = await reviewNextOf(action, command.input ?? {}, {
          commandId: command.commandId,
          ...(command.origin !== undefined ? { origin: command.origin } : {}),
          filterResources: (candidates) => reporter.filterCandidateResources(command.commandId, candidates),
        });
        outcome = { status: "COMPLETED", result: { next } };
      } catch (error) {
        const code = (error as { code?: string }).code;
        outcome = { status: "FAILED", failureReason: "ERROR", errorCode: code ?? "REVIEW_FAILED", errorMessage: error instanceof Error ? error.message : String(error) };
      }
    }
    const cause = commands.beginReporting(command.commandId, outcome);
    if (cause !== undefined) outcome = causeOutcome(cause);
    await reportOwed(reporter, command.commandId, outcome);
  }

  /**
   * Report a terminal outcome, and record whether the Platform accepted it.
   *
   * A failed report does NOT settle the command: the outcome is kept so a
   * redelivery replays it and a drain still counts it as owed. Settling on
   * failure left the Platform RUNNING with no recovery path at all — the
   * action would never re-run and the outcome would never be sent again
   * (review 2188).
   */
  async function reportOwed(
    reporter: CeServiceConnector,
    commandId: string,
    outcome: Parameters<CeServiceConnector["reportCommandResult"]>[1],
  ): Promise<void> {
    try {
      const ack = await reporter.reportCommandResult(commandId, outcome);
      if (ack.accepted) {
        // The Platform's canonical status (present on ALREADY_TERMINAL) wins
        // over the local one in the tombstone (review 2201).
        commands.reported(commandId, ack.canonicalStatus);
        return;
      }
      // A 200 that refuses — UNKNOWN_COMMAND, OWNERSHIP_MISMATCH. Retrying
      // cannot change either answer, so the outcome is not kept owed; it is
      // settled and logged as unaccepted rather than replayed for ever.
      commands.reported(commandId);
      opts.onReportRejected?.({ commandId, outcome: outcome as Record<string, unknown>, reason: ack.outcome });
    } catch {
      // Transport or 5xx: the Platform may yet take it. Keep it owed, on a
      // backoff the registry schedules.
      commands.reportFailed(commandId, outcome as Record<string, unknown>);
    }
  }

  /** Re-report everything whose retry is due. Driven on the heartbeat cadence. */
  async function retryOwedReports(all = false): Promise<void> {
    if (!connector) return;
    // claimDueRetries moves each one to `reporting` before it is returned, so
    // an overlapping driver (a slow tick, a drain racing the interval) finds
    // nothing due rather than double-sending (review 2194).
    for (const owed of commands.claimDueRetries(all)) {
      await reportOwed(connector, owed.commandId, owed.outcome as Parameters<CeServiceConnector["reportCommandResult"]>[1]);
    }
  }

  /** The terminal outcome for an execution stopped by a known cause. */
  function causeOutcome(cause: CommandStopCause): Parameters<CeServiceConnector["reportCommandResult"]>[1] {
    if (cause === "CANCELLED") {
      return { status: "FAILED", failureReason: "CANCELLED", errorCode: "CANCELLED", errorMessage: "command cancelled by the server" };
    }
    return {
      status: "FAILED",
      errorCode: cause === "SHUTDOWN" ? "SDK_SHUTDOWN" : "TRANSPORT_FATAL",
      errorMessage:
        cause === "SHUTDOWN"
          ? "execution aborted because the SDK is shutting down"
          : "execution aborted because the delivery transport terminated",
    };
  }

  /** The terminal outcome for an action that threw on its own. */
  function terminalOutcome(_unused: undefined, error: unknown): Parameters<CeServiceConnector["reportCommandResult"]>[1] {
    return { status: "FAILED", errorCode: "ACTION_FAILED", errorMessage: error instanceof Error ? error.message : "action handler failed" };
  }

  try {
    connector = new CeServiceConnector({
      serverUrl: opts.serverUrl,
      manifest,
      address,
      instanceId: opts.instanceId,
      registrationToken: opts.registrationToken,
      controlToken: opts.controlToken,
      fetchImpl: opts.fetchImpl,
      // This function owns the listener and enforces currentCallbackToken on
      // every inbound route, so the declaration is truthful here (#71).
      declareCallbackTokenSupport: !opts.listenOnly,
    });
    if (opts.listenOnly) {
      // World B: the Platform finds US. The connector instance exists only to reuse
      // the message-handling machinery; it never talks to the Platform.
      return {
        connector,
        agent: connector, // deprecated compatibility alias (same instance)
        address,
        port,
        close: async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        publishCheckpoints: async () => {
          throw new Error("publishCheckpoints: a listen-only (World B) descriptor is an operator-provisioned atomic snapshot; growth is a re-provision");
        },
      };
    }
    const registration = await connector.register();
    registered = true;
    if (checkpointsFactory) {
      const reporter = connector;
      adoptCheckpoints(
        await checkpointsFactory({
          instanceId: reporter.instanceId,
          listExecutionProfiles: () => reporter.listExecutionProfiles(),
          publishResourceExtractorArtifact: (input) => reporter.publishResourceExtractorArtifact(input),
        }),
      );
      actions = normalizeActions();
      validateActions(actions, "startup");
    }
    if (checkpoints.length > 0) {
      await connector.publishAuthorityDescriptor(authorityDescriptor());
    }
    // This is the sole World A transition that opens messages and Actions.
    // Governed Services cannot reach it until descriptor admission succeeds;
    // legacy Services reach it immediately after successful registration.
    operationalReady = true;
    // Platform-minted per-instance credential (docs#122) wins over any static
    // configuration: from here on, inbound calls must present it. Adopted by
    // reference so every route handler sees the rotated value after a
    // re-registration without re-wiring.
    // Adoption is read live via expectedCallbackToken(); nothing to capture.
    if (opts.heartbeatMs !== 0) connector.startHeartbeat(opts.heartbeatMs ?? 10_000);
    // The retry OWNER for terminal outcomes the Platform has not taken.
    // Without one, "replay until accepted" was only true when something else
    // happened to redeliver the command — and on World A nothing does, since
    // the COMMAND was acked and long-poll dedupe suppresses it (review 2191).
    // This runs on its own cadence, independent of any delivery.
    reportRetryTimer = setInterval(() => void retryOwedReports(), Math.max(1_000, Math.floor((opts.heartbeatMs ?? 10_000) / 2)));
    (reportRetryTimer as { unref?: () => void }).unref?.();

    // World A (agent-nodejs#44, contracts 0.7.4): the Platform provisioned this
    // instance LONG_POLL — commands, cancels, and routed messages arrive on
    // the delivery stream instead of pushed HTTP calls. The inbound listener
    // stays up for compatibility (health, legacy push), but the loop is the
    // command channel.
    if (registration.transport?.mode === "LONG_POLL") {
      const reporter = connector;
      pollLoop = new CeLongPollLoop({
        serverUrl: opts.serverUrl,
        instanceId: reporter.instanceId,
        transport: registration.transport,
        authHeaders: () => reporter.instanceAuthHeaders(),
        fetchImpl: opts.fetchImpl,
        handlers: {
          onExecute: (command) => {
            // Fire-and-forget by design: ack means "accepted", the result
            // rides the report path; the loop must keep polling while the
            // action runs.
            void runDeliveredExecute(reporter, command);
          },
          onReview: (command) => {
            void runDeliveredReview(reporter, command);
          },
          onCancel: (cancellation) => {
            // Recorded even when nothing is running yet: a CANCEL that beats
            // its COMMAND on the same stream must refuse the execute when it
            // arrives, not be forgotten (review 2185).
            commands.cancel(cancellation.commandId);
          },
          onMessage: async (message) => {
            const reply = await reporter.handleMessage(message, opts.handler);
            // Reply on the result stream (doc §9 note): the service's own
            // outbound post into the conversation.
            await reporter.postMessageEnvelope(reply);
          },
          onFatal: (error) => {
            // A dead delivery channel must never coexist with a healthy-looking
            // runtime. Stop heartbeats immediately, fail local health, abort
            // active work, and surface the terminal condition to the caller.
            transportFatalError = error;
            operationalReady = false;
            reporter.stopHeartbeat();
            reporter.setHealth("UNREACHABLE");
            commands.abortAll("TRANSPORT_FATAL");
            opts.onTransportFatal?.(error);
          },
        },
      });
      void pollLoop.start();
    }
  } catch (error) {
    operationalReady = false;
    connector?.stopHeartbeat();
    await pollLoop?.stop();
    // Registration precedes authority admission. End the exact incarnation on
    // admission failure so no half-started Worker remains routable.
    if (registered) {
      await connector?.deregister().catch(() => {
        /* preserve the admission failure as the primary error */
      });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    connector,
    agent: connector, // deprecated compatibility alias (same instance)
    address,
    port,
    publishCheckpoints: growCheckpoints,
    async close() {
      operationalReady = false;
      // Stop taking new deliveries first, then give outstanding work a bounded
      // window to settle, then tear down lifecycle.
      //
      // "Outstanding" counts commands still REPORTING as well as still
      // executing. Waiting only on execution let a process that had finished
      // its actions look idle while terminal outcomes were still in flight, so
      // shutting down here could deregister and lose one — leaving the
      // Platform RUNNING for ever, with nothing left to settle it by time
      // (review 2185, docs#242).
      await pollLoop?.stop();
      if (reportRetryTimer) clearInterval(reportRetryTimer);
      const drainDeadline = Date.now() + 10_000;
      while (commands.outstanding > 0 && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (commands.outstanding > 0) {
        commands.abortAll("SHUTDOWN");
        const abortDeadline = Date.now() + 1_000;
        while (commands.outstanding > 0 && Date.now() < abortDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      // One last attempt at anything the Platform never acknowledged. After
      // this the outcome is lost with the process — but a command left RUNNING
      // is settled by an operator's cancel, not by a clock (docs#242), so
      // trying once more here is worth more than a tidy exit.
      await retryOwedReports(true);
      connector?.stopHeartbeat();
      await connector?.deregister().catch(() => {
        /* best-effort on shutdown */
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

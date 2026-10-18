import { randomUUID } from "node:crypto";
import {
  CommandResultReportResponseSchema,
  type ActionCommandResult,
  type CommandFailureReason,
  type TransportParameters,
  TransportParametersSchema,
  CE_CONTRACT_VERSION,
  type ServiceManifest,
  type Worker,
  WorkerSchema,
  type ConversationMessage,
  ConversationMessageSchema,
  type ConnectorHeartbeat,
  type WorkerHealth,
  CheckpointDefinitionSchema,
  type CheckpointDefinition, CandidateResourceFilterRequestSchema, CandidateResourceFilterResponseSchema, CandidateResourceFilterExchangeSchema } from "@xtrape/contracts";

/**
 * Xtrape CE Phase 0 service connector.
 *
 * Framework-agnostic SDK for an `xtrape-service` to:
 *  - register an instance to `xtrape-platform-ce`;
 *  - send heartbeats;
 *  - validate inbound ConversationMessages and build replies.
 *
 * See xtrape-docs runtime-platform/04 (registration & heartbeat) and /03 (message).
 */
export interface CeServiceConnectorOptions {
  /** xtrape-platform-ce base URL, e.g. http://localhost:3000 */
  serverUrl: string;
  /** this service's manifest */
  manifest: ServiceManifest;
  /** this instance's reachable address (URL) */
  address: string;
  /** optional fixed instance id; defaults to `<serviceId>-<rand>` */
  instanceId?: string;
  /**
   * Declare adoption of the Platform-minted callback token in the registration
   * body (contracts#82). Set this ONLY when the caller controls the service's
   * inbound auth and will enforce `currentCallbackToken` on every inbound
   * call — serveCeService does; a service running its own HTTP listener must
   * opt in itself, or the Platform switches to a credential the listener never
   * checks and every dial 401s. Default false.
   */
  declareCallbackTokenSupport?: boolean;
  /**
   * Shared registration token. When platform-ce has `SERVER_CE_REGISTRATION_TOKEN`
   * set, registration requires it; the connector sends it as the
   * `x-xtrape-registration-token` header on register.
   *
   * Transitional note (applies to every `SERVER_CE_*` name below): the control
   * plane's canonical env prefix is `PLATFORM_CE_*` (server-ce#145). The
   * `SERVER_CE_*` spellings are kept verbatim here because they remain accepted
   * as deprecated compatibility aliases; do not rewrite them as prose.
   */
  registrationToken?: string;
  /**
   * 0.6.x control-plane token. When platform-ce has `SERVER_CE_CONTROL_TOKEN` set,
   * older non-registration routes may require it. Current platform-ce returns a
   * per-instance access token during registration and the connector uses that token
   * for heartbeat/deregister; this control token is a compatibility fallback
   * (see xtrape-server-ce#12).
   */
  controlToken?: string;
  /** injectable fetch (tests); defaults to global fetch */
  fetchImpl?: typeof fetch;
}

export interface CeServiceRegistrationResult {
  instanceId: string;
  accessToken?: string;
  /**
   * Per-instance credential the PLATFORM will present when it dials this
   * instance back (contracts `callbackToken`, docs#122). The SDK adopts it
   * for inbound authentication automatically; re-registration rotates it.
   */
  callbackToken?: string;
  /**
   * Platform-authoritative World A transport parameters (contracts 0.7.4
   * WorldACeRegistrationResponse). Present iff the Platform provisioned this
   * instance LONG_POLL — the connector then long-polls for deliveries instead of
   * serving pushed commands, and never invents its own poll parameters.
   */
  transport?: TransportParameters;
}

/** One immutable content-addressed JSON Schema record published before the
 * Checkpoints that reference it. `digest` is required so a Service can bind
 * its Checkpoint definition before it starts; Platform recomputes it. */
export interface CeSchemaRecordDefinition {
  bytesJson: string;
  dialect: string;
  digest: string;
}

/** Schema + Checkpoint + exact Action binding admitted as one revision. */
export interface CeAuthorityDescriptor {
  manifest: ServiceManifest;
  actions: Array<Record<string, unknown> & { name: string; checkpoint?: CheckpointDefinition["id"] }>;
  schemaRecords: CeSchemaRecordDefinition[];
  checkpoints: CheckpointDefinition[];
}

export type CeMessageReply =
  | string
  | { content: string; messageType?: ConversationMessage["messageType"]; payload?: Record<string, unknown> };

/** Handler invoked with a validated inbound message; returns the reply content. */
export type CeMessageHandler = (msg: ConversationMessage) => CeMessageReply | Promise<CeMessageReply>;

export class CeInboundMessageValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CeInboundMessageValidationError";
  }
}

/** A non-2xx answer from the Platform, with its status kept machine-readable. */
export class CePlatformHttpError extends Error {
  readonly status: number;
  constructor(path: string, status: number, bodyText: string) {
    super(`platform-ce ${path} -> ${status}: ${bodyText}`);
    this.name = "CePlatformHttpError";
    this.status = status;
  }
}

/**
 * What the Platform said about a reported terminal outcome.
 *
 * `accepted` is the only thing a caller should branch on: APPLIED means it
 * took the outcome, ALREADY_TERMINAL means it already had one — both leave
 * nothing owed. UNKNOWN_COMMAND and OWNERSHIP_MISMATCH are refusals that
 * arrive with a 200, and retrying them will not help.
 */
export interface CommandReportAck {
  accepted: boolean;
  /**
   * The Platform's answer. The first four are the frozen
   * `CommandResultReportResponse` union; `HTTP_REJECTED` is this SDK's
   * classification of a permanent HTTP refusal (403/404/409-class) on the
   * legacy report path, which answers no union at all. Both refusal kinds mean
   * the same thing to the caller: retrying cannot change the answer.
   */
  outcome: "APPLIED" | "ALREADY_TERMINAL" | "UNKNOWN_COMMAND" | "OWNERSHIP_MISMATCH" | "HTTP_REJECTED";
  /** The status code behind HTTP_REJECTED, for the caller's log. */
  httpStatus?: number;
  /**
   * The Platform's CANONICAL terminal status, when its answer names one — the
   * frozen ALREADY_TERMINAL arm always does. The Platform is the authority on
   * how a command ended: on ALREADY_TERMINAL it had already settled the
   * command, possibly differently from what this connector just reported, and
   * anything remembering "how it ended" must remember THIS value, not the
   * local one (review 2201).
   */
  canonicalStatus?: "COMPLETED" | "FAILED";
}

/**
 * HTTP statuses on which re-sending the SAME report can never succeed: the
 * request was understood and refused. Everything else — network failures,
 * 5xx, 408, 429, and 401 (a rotated token that a re-registration may yet
 * restore) — stays a transient error, kept owed and retried. Classifying all
 * of these as transient made the retry owner re-send a refused report for
 * ever, without ever surfacing `onReportRejected` (review 2194).
 */
const PERMANENT_REPORT_REJECTIONS = new Set([400, 403, 404, 409, 410, 422]);

export class CeServiceConnector {
  readonly serviceId: string;
  readonly instanceId: string;
  private readonly serverUrl: string;
  private readonly manifest: ServiceManifest;
  private readonly address: string;
  private readonly tenant: string;
  private readonly registrationToken?: string;
  private readonly controlToken?: string;
  private readonly fetchImpl: typeof fetch;
  private accessToken?: string;
  private transport?: TransportParameters;
  private health: WorkerHealth = "HEALTHY";
  private hbTimer?: ReturnType<typeof setInterval>;

  constructor(opts: CeServiceConnectorOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.manifest = opts.manifest;
    this.address = opts.address;
    this.tenant = opts.manifest.tenant ?? "default";
    this.serviceId = opts.manifest.service.id;
    this.instanceId = opts.instanceId ?? `${this.serviceId}-${randomUUID().slice(0, 8)}`;
    this.declareCallbackTokenSupport = opts.declareCallbackTokenSupport === true;
    this.registrationToken = opts.registrationToken;
    this.controlToken = opts.controlToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Header carrying the per-instance access token returned by registration.
   * Falls back to the transitional control token for compatibility with older
   * platform-ce deployments that did not mint per-instance access tokens yet.
   */
  private lifecycleAuthHeaders(): Record<string, string> | undefined {
    if (this.accessToken) return { "x-xtrape-access-token": this.accessToken };
    return this.controlToken ? { "x-xtrape-control-token": this.controlToken } : undefined;
  }

  /** The Worker this connector reports on register/heartbeat. */
  instance(): Worker {
    return WorkerSchema.parse({
      contractVersion: CE_CONTRACT_VERSION,
      serviceId: this.serviceId,
      instanceId: this.instanceId,
      tenant: this.tenant,
      address: this.address,
      version: this.manifest.service.version,
      health: this.health,
      // Adoption declaration (contracts#82) is OPT-IN by whoever controls the
      // inbound auth surface (review #71 blocker 1): this class is also used
      // by services that run their own HTTP listener, where the SDK guards
      // nothing — declaring for them would make the Platform switch to the
      // derived token while their listener still enforces the old one, and
      // every dial would 401. serveCeService, which does own the listener,
      // declares; bare CeServiceConnector users must declare explicitly.
      ...(this.declareCallbackTokenSupport ? { supportsCallbackToken: true } : {}),
    });
  }

  /**
   * The callback credential currently adopted from the LATEST registration —
   * re-registering rotates it, and inbound verification must follow the
   * rotation (review #71 blocker 2), so readers must not cache this value.
   */
  get currentCallbackToken(): string | undefined {
    return this.callbackToken;
  }

  /** POST /v1/instances { manifest, instance } (sends the registration token if set). */
  async register(): Promise<CeServiceRegistrationResult> {
    const headers = this.registrationToken
      ? { "x-xtrape-registration-token": this.registrationToken }
      : undefined;
    const response = await this.post("/v1/instances", { manifest: this.manifest, instance: this.instance() }, headers);
    const accessToken = typeof response === "object" && response !== null && "accessToken" in response
      ? (response as { accessToken?: unknown }).accessToken
      : undefined;
    if (typeof accessToken === "string" && accessToken.length > 0) {
      this.accessToken = accessToken;
    }
    // World A provisioning (contracts 0.7.4): the registration response may
    // carry Platform-authoritative transport parameters. Validate strictly —
    // silently mis-parsing them would leave the instance provisioned for a
    // channel it never polls.
    const rawCallback = typeof response === "object" && response !== null && "callbackToken" in response
      ? (response as { callbackToken?: unknown }).callbackToken
      : undefined;
    this.callbackToken = typeof rawCallback === "string" && rawCallback.length > 0 ? rawCallback : undefined;
    const rawTransport = typeof response === "object" && response !== null && "transport" in response
      ? (response as { transport?: unknown }).transport
      : undefined;
    this.transport = rawTransport !== undefined ? TransportParametersSchema.parse(rawTransport) : undefined;
    return {
      instanceId: this.instanceId,
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
      ...(this.callbackToken ? { callbackToken: this.callbackToken } : {}),
      ...(this.transport ? { transport: this.transport } : {}),
    };
  }

  /**
   * Publish immutable Checkpoint definitions under this Worker's authenticated
   * Service identity. The Platform, not the body, decides publication
   * authority from the per-instance access token.
   *
   * Re-publication is intentionally safe: the Platform accepts byte-equivalent
   * definitions and rejects the same version triple with different semantics.
   */
  async publishCheckpoints(definitions: readonly CheckpointDefinition[]): Promise<void> {
    const headers = this.lifecycleAuthHeaders();
    if (!headers) throw new Error("checkpoint publication requires a registered Worker access token");
    for (const candidate of definitions) {
      const definition = CheckpointDefinitionSchema.parse(candidate);
      if (definition.id.serviceId !== this.serviceId) {
        throw new Error(
          `checkpoint ${definition.id.checkpointId}@${definition.id.checkpointVersion} belongs to ${definition.id.serviceId}, expected ${this.serviceId}`,
        );
      }
      await this.post(
        `/v1/instances/${encodeURIComponent(this.instanceId)}/checkpoints`,
        {
          definition,
          serviceId: definition.id.serviceId,
          checkpointId: definition.id.checkpointId,
          checkpointVersion: definition.id.checkpointVersion,
        },
        headers,
      );
    }
  }

  /** Publish content-addressed schema records under this Worker's credential. */
  async publishSchemaRecords(records: readonly CeSchemaRecordDefinition[]): Promise<void> {
    const headers = this.lifecycleAuthHeaders();
    if (!headers) throw new Error("schema publication requires a registered Worker access token");
    for (const record of records) {
      await this.post(
        `/v1/instances/${encodeURIComponent(this.instanceId)}/schema-records`,
        { bytesJson: record.bytesJson, dialect: record.dialect, digest: record.digest },
        headers,
      );
    }
  }

  /** Publish one atomic authority snapshot for this registered Worker. */
  async publishAuthorityDescriptor(descriptor: CeAuthorityDescriptor): Promise<void> {
    const headers = this.lifecycleAuthHeaders();
    if (!headers) throw new Error("authority descriptor publication requires a registered Worker access token");
    if (descriptor.manifest.service.id !== this.serviceId) {
      throw new Error(`authority descriptor belongs to ${descriptor.manifest.service.id}, expected ${this.serviceId}`);
    }
    await this.post(
      `/v1/instances/${encodeURIComponent(this.instanceId)}/authority-descriptor`,
      descriptor,
      headers,
    );
  }

  private callbackToken?: string;
  private readonly declareCallbackTokenSupport: boolean;

  /** Transport parameters from the last registration, if World A provisioned. */
  get transportParameters(): TransportParameters | undefined {
    return this.transport;
  }

  /** Auth headers for instance self-routes (poll/ack/report/messages). */
  instanceAuthHeaders(): Record<string, string> | undefined {
    return this.lifecycleAuthHeaders();
  }

  /**
   * Lifecycle convenience: register, then start periodic heartbeats. Returns a
   * `stop()` that stops heartbeats and best-effort deregisters — so a service
   * does not have to wire register/heartbeat/deregister by hand.
   */
  async start(opts: { heartbeatMs?: number; metrics?: () => Record<string, unknown> } = {}): Promise<() => Promise<void>> {
    await this.register();
    if (opts.heartbeatMs !== 0) this.startHeartbeat(opts.heartbeatMs ?? 10_000, opts.metrics);
    return async () => {
      this.stopHeartbeat();
      await this.deregister().catch(() => {
        /* best-effort on shutdown */
      });
    };
  }

  setHealth(h: WorkerHealth): void {
    this.health = h;
  }

  /** POST /v1/instances/{id}/heartbeat */
  async sendHeartbeat(metricsSummary?: Record<string, unknown>): Promise<void> {
    const hb: ConnectorHeartbeat = {
      contractVersion: CE_CONTRACT_VERSION,
      serviceId: this.serviceId,
      instanceId: this.instanceId,
      tenant: this.tenant,
      ts: new Date().toISOString(),
      health: this.health,
      ...(metricsSummary ? { metricsSummary } : {}),
    };
    await this.post(`/v1/instances/${encodeURIComponent(this.instanceId)}/heartbeat`, hb, this.lifecycleAuthHeaders());
  }

  /** Start a periodic heartbeat; returns a stop function. Timer is unref'd. */
  startHeartbeat(intervalMs = 10_000, metrics?: () => Record<string, unknown>): () => void {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      void this.sendHeartbeat(metrics?.()).catch(() => {
        /* heartbeat failures are tolerated; the Platform marks the instance UNREACHABLE */
      });
    }, intervalMs);
    this.hbTimer.unref?.();
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = undefined;
    }
  }

  /** DELETE /v1/instances/{id} — graceful deregister. */
  async deregister(): Promise<void> {
    await this.fetchJson(`/v1/instances/${encodeURIComponent(this.instanceId)}`, {
      method: "DELETE",
      ...(this.lifecycleAuthHeaders() ? { headers: this.lifecycleAuthHeaders() } : {}),
    });
  }

  /**
   * Report the outcome of an async action (server-ce#41 Stage B):
   * POST /v1/instances/{instanceId}/commands/{commandId}/result using the
   * per-instance access token. `outcome.result` carries the action payload for
   * COMPLETED; errorCode/errorMessage describe a FAILED run.
   */
  /**
   * runtime-platform/13 §4.3 (docs#288): the candidate Resource exchange a
   * REVIEW runs before offering a target choice — the Service submits the
   * identifiers it would offer, the Platform answers the admitted subset
   * (normalized, intersected with the session's authorization). Only what
   * comes back may be presented. Platform endpoint: platform-ce#312.
   */
  async filterCandidateResources(commandId: string, candidates: string[]): Promise<string[]> {
    const request = CandidateResourceFilterRequestSchema.parse({ contractVersion: CE_CONTRACT_VERSION, commandId, candidates });
    const answer = await this.post(
      `/v1/instances/${encodeURIComponent(this.instanceId)}/commands/${encodeURIComponent(commandId)}/candidate-resources`,
      request,
      this.lifecycleAuthHeaders(),
    );
    const response = CandidateResourceFilterResponseSchema.parse(answer);
    // The exchange invariant is checked HERE too: an answer outside the
    // submitted set is a Platform contract defect, not a list to present.
    CandidateResourceFilterExchangeSchema.parse({ request, response });
    return response.admitted;
  }

  async reportCommandResult(
    commandId: string,
    outcome: {
      status: "COMPLETED" | "FAILED";
      result?: Record<string, unknown>;
      errorCode?: string;
      errorMessage?: string;
      /**
       * 0.7.3 CE report dialect (contracts CommandResultReport): TIMEOUT and
       * CANCELLED are failure REASONS under FAILED. Supplying one switches the
       * report onto the CE wire (instanceId-claimed); omitted keeps the legacy
       * ActionCommandResult body byte-compatible with older servers.
       */
      failureReason?: CommandFailureReason;
    },
  ): Promise<CommandReportAck> {
    const body: ActionCommandResult & { instanceId?: string; failureReason?: CommandFailureReason } = {
      contractVersion: CE_CONTRACT_VERSION,
      commandId,
      status: outcome.status,
      ...(outcome.failureReason ? { instanceId: this.instanceId, failureReason: outcome.failureReason } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    };
    let answer: unknown;
    try {
      answer = await this.post(
        `/v1/instances/${encodeURIComponent(this.instanceId)}/commands/${encodeURIComponent(commandId)}/result`,
        body,
        this.lifecycleAuthHeaders(),
      );
    } catch (error) {
      // A permanent refusal is an ANSWER, not an outage. On the legacy report
      // path the Platform refuses with a plain 4xx rather than the frozen
      // union; passing that on as a generic exception put it in the same
      // bucket as a network blip, so the retry owner re-sent it for ever and
      // `onReportRejected` never fired (review 2194).
      const status = error instanceof CePlatformHttpError ? error.status : undefined;
      if (status !== undefined && PERMANENT_REPORT_REJECTIONS.has(status)) {
        return { accepted: false, outcome: "HTTP_REJECTED", httpStatus: status };
      }
      throw error;
    }
    // A 200 is not acceptance. The Platform answers a frozen discriminated
    // union, and two of its arms are refusals: UNKNOWN_COMMAND (it has no such
    // command) and OWNERSHIP_MISMATCH (this instance does not own it). Reading
    // only the status code counted both as accepted and threw away the
    // outcome that still needed delivering (review 2191). An older server that
    // answers nothing recognisable is treated as acceptance, because that is
    // what it meant before this union existed.
    const parsed = CommandResultReportResponseSchema.safeParse(answer);
    if (!parsed.success) return { accepted: true, outcome: "APPLIED" };
    const reported = parsed.data.outcome;
    return {
      accepted: reported === "APPLIED" || reported === "ALREADY_TERMINAL",
      outcome: reported,
      // ALREADY_TERMINAL carries the status the Platform settled on. Dropping
      // it left the tombstone holding the LOCAL report — so a command the
      // Platform had already FAILED could later be described as COMPLETED,
      // contradicting the authority (review 2201).
      ...(reported === "ALREADY_TERMINAL" ? { canonicalStatus: parsed.data.status } : {}),
    };
  }

  /**
   * Post a persist-only, service-originated conversation message
   * (server-ce#63 Gap 2): POST /v1/instances/{instanceId}/messages using the
   * per-instance access token. No forward target and no reply — the Platform
   * persists it into the conversation and poll-based surfaces read it back
   * through the conversation read API. Long-running services use this for
   * unsolicited progress updates and questions to the user; task correlation
   * (and any other product semantics) rides the opaque `payload`.
   */
  async postConversationMessage(msg: {
    conversationId: string;
    /** Who the message is for; informational, never routed. Defaults to USER. */
    targetType?: "USER" | "TASK" | "SYSTEM";
    targetId: string;
    messageType?: ConversationMessage["messageType"];
    content: string;
    payload?: unknown;
    replyToMessageId?: string;
    /** Dedup key; generated when omitted. */
    messageId?: string;
  }): Promise<ConversationMessage> {
    const envelope = ConversationMessageSchema.parse({
      contractVersion: CE_CONTRACT_VERSION,
      messageId: msg.messageId ?? `msg_${randomUUID().slice(0, 12)}`,
      conversationId: msg.conversationId,
      tenant: this.tenant,
      targetType: msg.targetType ?? "USER",
      targetId: msg.targetId,
      // sender identity is also enforced server-side against the access token
      senderType: "SERVICE",
      senderId: this.serviceId,
      messageType: msg.messageType ?? "TEXT",
      content: msg.content,
      ...(msg.payload !== undefined ? { payload: msg.payload } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
    });
    await this.postMessageEnvelope(envelope);
    return envelope;
  }

  /**
   * Post a prebuilt ConversationMessage envelope through the persist-only
   * instance route. World A message replies ride this outbound post (doc §9
   * note): the delivery stream carries the request, the reply is the
   * service's own message into the conversation.
   */
  async postMessageEnvelope(envelope: ConversationMessage): Promise<void> {
    await this.post(
      `/v1/instances/${encodeURIComponent(this.instanceId)}/messages`,
      ConversationMessageSchema.parse(envelope),
      this.lifecycleAuthHeaders(),
    );
  }

  /**
   * Open questions this Service has put to a person, keyed by the question's
   * conversationId. One live question per conversation: a second `ask` on the
   * same conversation before the first is answered is a caller bug, refused
   * loudly rather than silently replacing a waiter someone is answering.
   */
  private readonly askWaiters = new Map<
    string,
    { requestMessageId: string; resolve: (m: ConversationMessage) => void; reject: (e: Error) => void }
  >();

  /**
   * Put a question to a person through the Platform, and wait for the answer.
   *
   * The interaction primitive (xtrape-docs#241): the Widget decides WHEN to
   * ask and what to do with the answer — both are business decisions — and it
   * never chooses a recipient. On the wire this is the canonical approval
   * shape (runtime-platform/03: approval rides `messageType`, a system-level
   * approval conversation uses `targetType: SYSTEM`): an `APPROVAL_REQUEST`
   * into a conversation, answered by an `APPROVAL_RESPONSE` on the ordinary
   * inbound message path. `payload` carries the command/execution linkage
   * (commandId and whatever the caller puts there) so the answer can be
   * correlated.
   *
   * WHAT THIS DOES NOT YET DO. It posts the question and correlates the
   * answer. It does NOT route the question to the person behind the command:
   * the Platform persists the SYSTEM conversation, but deriving "who to ask,
   * on which interactive layer" from the requester's identity credential and
   * delivering it there is Platform-side work that does not exist yet
   * (xtrape-docs#241). Until it does, a person reads the question from the
   * conversation surface (e.g. Panel) and answers there. This method is the
   * Widget-side seam that work plugs into, not the whole path.
   *
   * Waiting has no deadline of its own — a person may take hours, and
   * correctness rides the queue+ack delivery semantics, not a held
   * connection. `signal` (typically the command's cancel signal) is what ends
   * a wait nobody answers.
   *
   * The returned message is the person's answer, verbatim. What the answer
   * MEANS — granted, refused, a value to continue with — is the caller's
   * business, carried in the opaque `payload`; this method only correlates it.
   */
  async ask(opts: {
    /** Conversation carrying this question; a stable per-question id, e.g. `apr_<commandId>`. */
    conversationId: string;
    /** What the person is being asked, with the disclosure they need to own the answer. */
    content: string;
    /** Business context (commandId, executionHash, …); rides opaquely. */
    payload?: unknown;
    /** Ends the wait (typically the command's cancel signal). */
    signal?: AbortSignal;
  }): Promise<ConversationMessage> {
    if (this.askWaiters.has(opts.conversationId)) {
      throw new Error(`a question is already pending on conversation "${opts.conversationId}"`);
    }
    // An already-cancelled command must not put an orphan question in front of
    // a person. Refuse before anything is posted.
    if (opts.signal?.aborted) {
      throw new Error("ask refused: the command was already cancelled");
    }

    // The waiter registers BEFORE the question is posted, so there is no gap
    // an answer can slip through — however fast the far side is, and however
    // the event loop interleaves.
    const requestMessageId = `msg_${randomUUID().slice(0, 12)}`;
    const answered = new Promise<ConversationMessage>((resolve, reject) => {
      const waiter = {
        requestMessageId,
        resolve: (m: ConversationMessage) => {
          cleanup();
          resolve(m);
        },
        reject: (e: Error) => {
          cleanup();
          reject(e);
        },
      };
      const onAbort = (): void => waiter.reject(new Error("ask aborted: the command was cancelled before anyone answered"));
      const cleanup = (): void => {
        this.askWaiters.delete(opts.conversationId);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.askWaiters.set(opts.conversationId, waiter);
    });
    // A post failure rejects `answered` below; without a catch of its own the
    // rejection would also surface as unhandled.
    answered.catch(() => undefined);

    try {
      await this.postConversationMessage({
        conversationId: opts.conversationId,
        targetType: "SYSTEM",
        targetId: opts.conversationId,
        messageType: "APPROVAL_REQUEST",
        content: opts.content,
        messageId: requestMessageId,
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      });
    } catch (error) {
      this.askWaiters.get(opts.conversationId)?.reject(
        new Error(`the question could not be posted: ${error instanceof Error ? error.message : String(error)}`),
      );
      throw error;
    }
    return await answered;
  }

  /**
   * Route an inbound message to a pending `ask`, if it answers one.
   *
   * An answer is an `APPROVAL_RESPONSE` in the conversation of a pending
   * question whose `replyToMessageId` names THAT question. Threading is
   * required, not merely honoured: a conversation holds one live waiter but is
   * not single-use — an abort frees it for a re-ask — so an untethered answer
   * to an earlier question could otherwise resolve the current one. Setting it
   * is the answering surface's job when it renders the request, never the
   * person's to type.
   */
  private consumeAskAnswer(msg: ConversationMessage): boolean {
    if (msg.messageType !== "APPROVAL_RESPONSE") return false;
    const waiter = this.askWaiters.get(msg.conversationId);
    if (!waiter) return false;
    // The answer MUST reference this question by replyToMessageId. Accepting an
    // untethered response would let a late answer to an earlier, aborted
    // question on a reused conversation resolve the current one — a conversation
    // is single-live-waiter but NOT single-use, since abort frees it for a
    // re-ask. Threading is the answering surface's job (Panel/Telegram set it
    // when they render the APPROVAL_REQUEST and collect the reply), never the
    // person's to type.
    if (msg.replyToMessageId !== waiter.requestMessageId) return false;
    waiter.resolve(msg);
    return true;
  }

  /**
   * Validate an inbound message, run the handler, and build the reply message
   * (senderType=SERVICE, targeted back at the sender, with replyToMessageId).
   */
  async handleMessage(raw: unknown, handler: CeMessageHandler): Promise<ConversationMessage> {
    let msg: ConversationMessage;
    try {
      msg = ConversationMessageSchema.parse(raw);
    } catch (error) {
      throw new CeInboundMessageValidationError(
        error instanceof Error ? error.message : "invalid inbound ConversationMessage",
        { cause: error },
      );
    }
    // An answer to a pending `ask` is consumed by the waiter, not handed to
    // the general handler: the code that asked is the code that understands
    // the answer. The acknowledgement reply closes the delivery loop.
    if (this.consumeAskAnswer(msg)) {
      return ConversationMessageSchema.parse({
        contractVersion: CE_CONTRACT_VERSION,
        messageId: `msg_${randomUUID().slice(0, 12)}`,
        conversationId: msg.conversationId,
        tenant: msg.tenant ?? "default",
        targetType: msg.senderType,
        targetId: msg.senderId,
        senderType: "SERVICE",
        senderId: this.serviceId,
        messageType: "SUMMARY",
        content: "answer received",
        replyToMessageId: msg.messageId,
      });
    }
    const out = await handler(msg);
    const reply = typeof out === "string" ? { content: out } : out;
    return ConversationMessageSchema.parse({
      contractVersion: CE_CONTRACT_VERSION,
      messageId: `msg_${randomUUID().slice(0, 12)}`,
      conversationId: msg.conversationId,
      tenant: msg.tenant ?? "default",
      // reply back to whoever sent it (USER/SERVICE/SYSTEM are all valid targets)
      targetType: msg.senderType,
      targetId: msg.senderId,
      senderType: "SERVICE",
      senderId: this.serviceId,
      messageType: reply.messageType ?? "SUMMARY",
      content: reply.content,
      replyToMessageId: msg.messageId,
      ...(reply.payload ? { payload: reply.payload } : {}),
    });
  }

  /**
   * The admitted execution-profile family (platform-ce#262): the digest a
   * Checkpoint definition's `resourceExtraction.executionProfileRecord` must
   * cite. Instance-authenticated read; structure only, nothing secret.
   */
  async listExecutionProfiles(): Promise<{ profiles: Array<{ digest: string; bytesJson: string; profile: Record<string, unknown>; createdAt: string }> }> {
    const headers = this.lifecycleAuthHeaders();
    if (!headers) throw new Error("execution-profile discovery requires a registered Worker access token");
    const body = await this.fetchJson(`/v1/instances/${encodeURIComponent(this.instanceId)}/resource-extractor-execution-profiles`, { method: "GET", headers });
    const profiles = typeof body === "object" && body !== null && Array.isArray((body as { profiles?: unknown }).profiles)
      ? ((body as { profiles: unknown[] }).profiles as Array<Record<string, unknown>>)
      : undefined;
    if (!profiles || profiles.some((p) => typeof p.digest !== "string" || typeof p.bytesJson !== "string")) {
      throw new Error("execution-profile discovery returned an unusable listing");
    }
    return { profiles: profiles as Array<{ digest: string; bytesJson: string; profile: Record<string, unknown>; createdAt: string }> };
  }

  /**
   * Publish one content-addressed static Resource-extractor artifact on the
   * instance's own route (platform-ce#207): exact canonical bytes, insert-only
   * and idempotent platform-side.
   */
  async publishResourceExtractorArtifact(input: { bytesJson: string; mediaType: string; digest?: string }): Promise<unknown> {
    const headers = this.lifecycleAuthHeaders();
    if (!headers) throw new Error("resource-extractor artifact publication requires a registered Worker access token");
    return this.post(`/v1/instances/${encodeURIComponent(this.instanceId)}/resource-extractor-artifacts`, input, headers);
  }

  private post(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown> {
    return this.fetchJson(path, { method: "POST", body: JSON.stringify(body), ...(headers ? { headers } : {}) });
  }

  private async fetchJson(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(this.serverUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CePlatformHttpError(path, res.status, text);
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`platform-ce ${path} returned non-JSON success response: ${text}`, { cause: error });
    }
  }
}

// ---------------------------------------------------------------------------
// Deprecated Agent-named aliases (connector-nodejs#79/#80, 0.8.0 concept
// freeze). Same class — `instanceof` and subclassing keep working. Wire
// behavior (endpoint paths, token prefixes, payloads) is unchanged.
// ---------------------------------------------------------------------------

/** @deprecated Renamed to {@link CeServiceConnector} (connector-nodejs#79, 0.8.0 concept freeze). */
export const CeServiceAgent = CeServiceConnector;
/** @deprecated Renamed to {@link CeServiceConnector} (connector-nodejs#79, 0.8.0 concept freeze). */
export type CeServiceAgent = CeServiceConnector;
/** @deprecated Renamed to {@link CeServiceConnectorOptions} (connector-nodejs#79, 0.8.0 concept freeze). */
export type CeServiceAgentOptions = CeServiceConnectorOptions;

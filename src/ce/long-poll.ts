import {
  CommandPollResponseSchema,
  type StreamDelivery,
  type TransportParameters,
  type ConversationMessage,
} from "@xtrape/contracts";

/**
 * World A long-poll delivery loop (agent-nodejs#44, contracts 0.7.4,
 * docs/09 §5.1/§5.4): the connector dials the Platform, hangs on
 * `GET /v1/instances/:id/deliveries/poll`, and receives COMMAND / CANCEL /
 * MESSAGE stream deliveries. The PLATFORM is the hanging side and enforces
 * `waitMs`; the client read timeout only guards a dead connection and must
 * exceed the Platform window.
 *
 * At-least-once semantics: the Platform redelivers unacked items, the connector
 * dedupes by the STABLE identity (commandId / cancelId / messageId) with a
 * bounded LRU and re-acks duplicates without re-executing. Acknowledgement
 * means "received, no redelivery needed" — never "executed"; results always
 * ride the report path.
 */

/** Client read margin on top of the Platform-enforced hang window. */
const READ_TIMEOUT_MARGIN_MS = 15_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const DEDUPE_LRU_SIZE = 1_024;

export interface CeLongPollHandlers {
  /**
   * An EXECUTE command delivery. Invoked once per commandId (deduped);
   * implementations run the action and report via the result path.
   */
  onExecute(command: Extract<StreamDelivery, { kind: "COMMAND" }>["command"]): void | Promise<void>;
  /**
   * A REVIEW command delivery (xtrape-docs#288, runtime-platform/13): the
   * read-only review step of a two-phase Checkpoint — answered on the report
   * path with `{ next }`, never executed. REQUIRED (review 3195): a loop that
   * can parse REVIEW must own its result; acking a delivery nobody answers
   * would leave the Platform command RUNNING for ever.
   */
  onReview(command: Extract<StreamDelivery, { kind: "COMMAND" }>["command"]): void | Promise<void>;
  /** A CANCEL delivery for a previously delivered (or unknown) command. */
  onCancel(cancellation: Extract<StreamDelivery, { kind: "CANCEL" }>["cancellation"]): void | Promise<void>;
  /** A routed ConversationMessage (doc §9 note): reply rides the outbound message post. */
  onMessage(message: ConversationMessage): void | Promise<void>;
  /**
   * Fatal, non-retryable loop end: the credential/incarnation is stale or the
   * instance is no longer provisioned LONG_POLL (401/404/409). The service
   * must re-register; the loop has already stopped.
   */
  onFatal?(error: Error): void;
  /** Non-fatal diagnostics (backoff, dropped PREPARE, handler errors). */
  onWarn?(message: string): void;
}

export interface CeLongPollOptions {
  serverUrl: string;
  instanceId: string;
  transport: TransportParameters;
  /** Auth headers for poll/ack (the per-instance access token). */
  authHeaders(): Record<string, string> | undefined;
  handlers: CeLongPollHandlers;
  /** injectable fetch (tests); defaults to global fetch */
  fetchImpl?: typeof fetch;
}

/** Bounded insertion-order LRU of already-accepted delivery identities. */
class DedupeLru {
  private readonly seen = new Set<string>();
  constructor(private readonly capacity: number) {}
  /** Returns true when the id is NEW (and records it). */
  accept(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }
}

export class CeLongPollLoop {
  private readonly serverUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dedupe = new DedupeLru(DEDUPE_LRU_SIZE);
  private stopped = false;
  private inFlightAbort?: AbortController;
  private runPromise?: Promise<void>;

  constructor(private readonly opts: CeLongPollOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Start the loop (idempotent). Resolves only when the loop ends. */
  start(): Promise<void> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  /** Stop the loop and abort the in-flight hanging request. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.inFlightAbort?.abort();
    await this.runPromise?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    let backoffMs = BACKOFF_INITIAL_MS;
    while (!this.stopped) {
      let res: Response;
      const requestStartedAt = Date.now();
      try {
        this.inFlightAbort = new AbortController();
        // The Platform hangs up to waitMs; the client timeout is a dead-link
        // guard strictly ABOVE that window, never the pacing mechanism.
        const timer = setTimeout(() => this.inFlightAbort?.abort(), this.opts.transport.waitMs + READ_TIMEOUT_MARGIN_MS);
        (timer as { unref?: () => void }).unref?.();
        try {
          res = await this.fetchImpl(`${this.serverUrl}/v1/instances/${encodeURIComponent(this.opts.instanceId)}/deliveries/poll`, {
            method: "GET",
            headers: this.opts.authHeaders(),
            signal: this.inFlightAbort.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (this.stopped) return;
        this.opts.handlers.onWarn?.(`poll failed (${(error as Error).message}); backing off ${backoffMs}ms`);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      if (res.status === 204) {
        backoffMs = BACKOFF_INITIAL_MS;
        // A healthy empty window means the PLATFORM hung for ~waitMs before
        // answering — re-poll immediately. An instant 204 (misbehaving proxy,
        // misconfigured Platform) would otherwise hot-loop the client; floor it.
        if (Date.now() - requestStartedAt < 250) await this.sleep(250);
        continue;
      }
      if (res.status === 401 || res.status === 404 || res.status === 409) {
        // Stale credential/incarnation or de-provisioned transport: polling
        // again can never succeed — surface and stop (re-registration is the
        // service's decision, not the loop's).
        const detail = await res.text().catch(() => "");
        this.stopped = true;
        this.opts.handlers.onFatal?.(new Error(`poll rejected with ${res.status}: ${detail.slice(0, 300)}`));
        return;
      }
      if (!res.ok) {
        this.opts.handlers.onWarn?.(`poll returned ${res.status}; backing off ${backoffMs}ms`);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      backoffMs = BACKOFF_INITIAL_MS;
      let batch;
      try {
        batch = CommandPollResponseSchema.parse(await res.json());
      } catch (error) {
        this.opts.handlers.onWarn?.(`poll batch failed contract validation: ${(error as Error).message}`);
        await this.sleep(backoffMs);
        continue;
      }
      await this.acceptBatch(batch.deliveries);
    }
  }

  /**
   * Accept a batch: dispatch NEW identities to handlers (batch order — an
   * EXECUTE and its CANCEL in one batch apply in delivery order), then ack
   * EVERY deliveryId. Ack = accepted locally; duplicates are re-acked without
   * re-dispatch; handler scheduling errors do not block the ack (the item
   * was received — redelivery would not help, results ride the report path).
   */
  private async acceptBatch(deliveries: StreamDelivery[]): Promise<void> {
    for (const item of deliveries) {
      try {
        if (item.kind === "COMMAND") {
          const { command } = item;
          if (!this.dedupe.accept(`cmd:${command.commandId}`)) continue;
          if (command.operation === "REVIEW") {
            // runtime-platform/13 §3: the review step travels as its own
            // delivery and is answered by its own owner — NEVER run as an execute.
            await this.opts.handlers.onReview(command);
            continue;
          }
          await this.opts.handlers.onExecute(command);
        } else if (item.kind === "CANCEL") {
          if (!this.dedupe.accept(`cnl:${item.cancellation.cancelId}`)) continue;
          await this.opts.handlers.onCancel(item.cancellation);
        } else {
          if (!this.dedupe.accept(`msg:${item.message.messageId}`)) continue;
          await this.opts.handlers.onMessage(item.message);
        }
      } catch (error) {
        this.opts.handlers.onWarn?.(`delivery handler failed for ${item.deliveryId}: ${(error as Error).message}`);
      }
    }
    try {
      await this.ack(deliveries.map((d) => d.deliveryId));
    } catch (error) {
      // Ack failure is tolerated: the items redeliver and the dedupe LRU
      // absorbs them (idempotent re-ack on the next batch).
      this.opts.handlers.onWarn?.(`ack failed: ${(error as Error).message}`);
    }
  }

  private async ack(deliveryIds: string[]): Promise<void> {
    if (deliveryIds.length === 0) return;
    const res = await this.fetchImpl(`${this.serverUrl}/v1/instances/${encodeURIComponent(this.opts.instanceId)}/deliveries/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.authHeaders() ?? {}) },
      body: JSON.stringify({ contractVersion: 1, deliveryIds }),
    });
    if (!res.ok) throw new Error(`ack returned ${res.status}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    });
  }
}

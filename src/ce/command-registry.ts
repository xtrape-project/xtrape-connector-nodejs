/**
 * What this process knows about one command, for as long as it matters.
 *
 * This replaces a bare `Map<commandId, AbortController>`, which could express
 * only "running or not" and therefore could not answer the questions the
 * lifecycle actually asks (reviews 2185 / 2188):
 *
 *  - **A cancel can arrive before the execute it cancels.** With presence as
 *    the only state there was nothing to write it on, so the cancel was
 *    answered "already terminal" and the execute then ran anyway — the exact
 *    outcome the cancel existed to prevent.
 *  - **A duplicate delivery can arrive after the action finished.** Deleting
 *    the entry on completion made a late redelivery indistinguishable from a
 *    first one, so a side-effecting action ran a second time.
 *  - **A terminal outcome can fail to reach the Platform.** Treating "the
 *    action finished" as "the Platform knows" was the same mistake one step
 *    later: a lost report left the Platform RUNNING while the tombstone
 *    guaranteed the command would neither run nor be reported again. Local
 *    completion and remote acknowledgement are separate facts, so they are
 *    separate states.
 *
 * ```text
 *   (nothing)
 *      ├── cancel first ─────► cancelled-before-start ──┐ (caller claims the
 *      └── execute first ───►  executing ──┐            │  CANCELLED report)
 *                                  ▲       ▼            ▼
 *                             cancel marks reporting ◄── claim ── unreported
 *                             the cause      │  (ONE attempt owns   ▲
 *                                            │   the delivery)      │ failed
 *                                            ├──► settled ──────────┘
 *                                            │   (acknowledged; remembers
 *                                            │    how it ended)
 *                                            └──► unreported (retry owed)
 * ```
 *
 * The invariant the whole thing exists for: **the business action executes
 * once; its terminal outcome is retried independently until the Platform
 * semantically accepts it.** Those are two different lifecycles sharing a
 * commandId, and conflating them is what produced every bug in this area.
 *
 * Retrying the report is NOT retrying the action: the effect already happened,
 * and only the Platform's knowledge is missing. Nor is it bounded by elapsed
 * time — a command the Platform never learns about is one an operator must
 * cancel by hand, so the retry backs off and holds rather than giving up
 * (docs#242). `CommandRegistry` owns the schedule; the caller drives it.
 */

/** Why an execution stopped, when it did not stop by finishing. */
export type CommandStopCause = "CANCELLED" | "SHUTDOWN" | "TRANSPORT_FATAL";

/** The terminal outcome of one execution, as reported to the Platform. */
export type TerminalOutcome = Record<string, unknown>;

export type CommandState =
  /** A cancel arrived for a command this process has not been asked to run. */
  | { phase: "cancelled-before-start"; at: number }
  /** The action is running. */
  | { phase: "executing"; abort: AbortController; cause?: CommandStopCause; at: number }
  /**
   * The action finished; ONE attempt now owns delivering its outcome. This
   * phase is the claim: retries and redeliveries both go through it, so two
   * attempts can never be in flight for the same command (review 2194).
   * `attempts` counts prior failed deliveries, so a retry that fails again
   * resumes its backoff instead of restarting it.
   */
  | { phase: "reporting"; outcome: TerminalOutcome; at: number; attempts?: number }
  /**
   * The action finished and its outcome is NOT known to have reached the
   * Platform. The outcome is kept so it can be replayed; the action is never
   * re-run.
   */
  | { phase: "unreported"; outcome: TerminalOutcome; at: number; attempts: number; nextAttemptAt: number }
  /**
   * Finished and acknowledged. A tombstone, aged out by settlement time. It
   * remembers HOW the command ended: a cancel arriving after settlement must
   * answer with the real terminal status — a command that COMPLETED, reported
   * and settled is not FAILED just because only the tombstone is left
   * (review 2194).
   */
  | {
      phase: "settled";
      at: number;
      terminalStatus?: "COMPLETED" | "FAILED";
      /**
       * A result frozen WITH the tombstone (review 3196): the dial transport's
       * REVIEW answers synchronously and owes nothing to the report path, but
       * 13 §5.5 still wants a retry of the same command id to recover the SAME
       * `next`. Keeping it here makes its retention mechanically coextensive
       * with the tombstone's — evicted together, never one without the other.
       */
      frozen?: Record<string, unknown>;
    };

/** How long a settled command is remembered, and how many at most. */
export interface CommandRegistryLimits {
  /** Tombstone lifetime. Long enough to outlive any plausible redelivery. */
  settledTtlMs: number;
  /** Upper bound on remembered commands, oldest SETTLEMENT evicted first. */
  maxTracked: number;
  /** First delay before re-reporting an outcome the Platform never took. */
  reportRetryBaseMs: number;
  /** Ceiling on that delay; the backoff doubles up to it and stays there. */
  reportRetryMaxMs: number;
}

export const DEFAULT_COMMAND_REGISTRY_LIMITS: CommandRegistryLimits = {
  settledTtlMs: 10 * 60_000,
  maxTracked: 4_096,
  reportRetryBaseMs: 2_000,
  reportRetryMaxMs: 60_000,
};

/** What `beginExecution` decided. */
export type BeginOutcome =
  /** Run it; `abort` is the signal to hand the action. */
  | { admit: true; abort: AbortController }
  /**
   * Do not run the action — but this outcome is owed to the Platform and has
   * not been acknowledged. Report it again.
   */
  | { admit: false; reason: "replay-outcome"; outcome: TerminalOutcome }
  /** Do not run it: already settled here — with the result frozen on the tombstone when the settlement kept one (review 3196). */
  | { admit: false; reason: "already-settled"; frozen?: Record<string, unknown> }
  /** Do not run it, and why — the caller answers accordingly. */
  | { admit: false; reason: "already-running" | "cancelled-before-start" };

/** What a cancel found. */
export interface CancelOutcome {
  outcome: "CANCELLING" | "ALREADY_TERMINAL";
  /** True when nothing was running and the cancel was recorded for a future execute. */
  preRecorded?: boolean;
  /**
   * How the command actually finished, when it is already terminal. The frozen
   * response carries a terminal status, and answering FAILED for a command
   * that COMPLETED describes the wrong thing (review 2191).
   */
  terminalStatus?: "COMPLETED" | "FAILED";
}

export class CommandRegistry {
  readonly #states = new Map<string, CommandState>();

  constructor(
    private readonly limits: CommandRegistryLimits = DEFAULT_COMMAND_REGISTRY_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Decide whether to run this command, and register the execution if so.
   *
   * Refuses a command already running here, one already acknowledged, and one
   * cancelled before it arrived — and hands back the outcome of one whose
   * report never landed, so the delivery that re-arrived becomes the chance to
   * report it again rather than a dead end.
   */
  beginExecution(commandId: string): BeginOutcome {
    this.#evict();
    const existing = this.#states.get(commandId);
    if (existing) {
      if (existing.phase === "executing" || existing.phase === "reporting") return { admit: false, reason: "already-running" };
      if (existing.phase === "unreported") {
        // The action already ran; its effect happened. What is missing is the
        // Platform knowing, so this redelivery replays the outcome.
        this.#states.set(commandId, { phase: "reporting", outcome: existing.outcome, at: this.now() });
        return { admit: false, reason: "replay-outcome", outcome: existing.outcome };
      }
      if (existing.phase === "settled") return { admit: false, reason: "already-settled", ...(existing.frozen !== undefined ? { frozen: existing.frozen } : {}) };
      // Cancelled before it started: the cancel wins. The record is NOT
      // settled here — the caller owes the Platform a CANCELLED outcome, and
      // it claims that report with beginReporting like every other one. A
      // premature tombstone made reportFailed a no-op for exactly that
      // outcome, silently dropping it (review 2194).
      return { admit: false, reason: "cancelled-before-start" };
    }
    const abort = new AbortController();
    this.#states.set(commandId, { phase: "executing", abort, at: this.now() });
    return { admit: true, abort };
  }

  /**
   * The action has finished with `outcome`, which is now on its way to the
   * Platform. Returns the cause the execution stopped for, if any, so the
   * caller can report a cancel or shutdown as such.
   *
   * Keeping the command tracked through this is what stops a shutdown from
   * concluding the process is idle while a terminal outcome is still in flight.
   */
  beginReporting(commandId: string, outcome: TerminalOutcome): CommandStopCause | undefined {
    const state = this.#states.get(commandId);
    const cause = state?.phase === "executing" ? state.cause : undefined;
    this.#states.set(commandId, { phase: "reporting", outcome, at: this.now() });
    return cause;
  }

  /**
   * The Platform accepted the terminal outcome.
   *
   * `canonicalStatus` is the status the PLATFORM settled on, when its answer
   * named one (the frozen ALREADY_TERMINAL arm always does). It wins over the
   * locally reported status: on ALREADY_TERMINAL the Platform had already
   * settled this command — possibly differently — and the tombstone answers
   * later cancels, so remembering the local value here contradicted the
   * authority (review 2201).
   */
  reported(commandId: string, canonicalStatus?: "COMPLETED" | "FAILED"): void {
    const prior = this.#states.get(commandId);
    const local = prior?.phase === "reporting" || prior?.phase === "unreported" ? prior.outcome["status"] : undefined;
    const status = canonicalStatus ?? (local === "COMPLETED" || local === "FAILED" ? local : undefined);
    this.#states.set(commandId, {
      phase: "settled",
      at: this.now(),
      ...(status !== undefined ? { terminalStatus: status } : {}),
    });
    this.#evict();
  }

  /**
   * The terminal outcome could not be delivered.
   *
   * The command stays owed: a redelivery replays the outcome instead of
   * re-running the action, and a drain still counts it as work outstanding.
   * Settling here instead would leave the Platform RUNNING with no recovery
   * path at all — neither re-execution nor re-report (review 2188).
   */
  reportFailed(commandId: string, outcome: TerminalOutcome): void {
    const prior = this.#states.get(commandId);
    // Only the attempt that holds the claim may record failure. Two attempts
    // used to be able to overlap — a slow one failing AFTER a fast one had
    // succeeded wrote the settled command back to unreported, regressing a
    // terminal state and re-sending an outcome the Platform had already taken
    // (review 2194). Since every attempt now starts by claiming `reporting`,
    // any other phase here means someone else finished first: nothing to do.
    if (prior?.phase !== "reporting") return;
    const attempts = (prior.attempts ?? 0) + 1;
    // Backoff doubles and then holds. It never gives up: a command the
    // Platform does not know about is one an operator has to cancel by hand,
    // and nothing settles it by time (docs#242), so retrying is strictly
    // better than a tidy surrender.
    const delay = Math.min(this.limits.reportRetryBaseMs * 2 ** (attempts - 1), this.limits.reportRetryMaxMs);
    this.#states.set(commandId, { phase: "unreported", outcome, at: this.now(), attempts, nextAttemptAt: this.now() + delay });
  }

  /**
   * Settle a command that has no report path at all (a synchronous transport,
   * where the answer IS the response). Nothing is owed once the caller has it.
   */
  settleWithoutReport(commandId: string, terminalStatus?: "COMPLETED" | "FAILED", frozen?: Record<string, unknown>): void {
    this.#states.set(commandId, { phase: "settled", at: this.now(), ...(terminalStatus !== undefined ? { terminalStatus } : {}), ...(frozen !== undefined ? { frozen } : {}) });
    this.#evict();
  }

  /**
   * Ask a running execution to stop, or record that a cancel arrived first.
   *
   * A cancel that beats its execute is the case a presence-only map could not
   * hold: it was answered "already terminal" — telling the Platform the cancel
   * had been applied — and the execute then ran regardless.
   */
  cancel(commandId: string): CancelOutcome {
    this.#evict();
    const state = this.#states.get(commandId);
    if (state?.phase === "executing") {
      state.cause = "CANCELLED";
      state.abort.abort();
      return { outcome: "CANCELLING" };
    }
    // Reporting or unreported: the action is over and its outcome is decided;
    // there is nothing left to stop. The outcome is still held, so the answer
    // can say how it finished rather than guessing.
    if (state?.phase === "reporting" || state?.phase === "unreported") {
      const reported = state.outcome["status"];
      return { outcome: "ALREADY_TERMINAL", terminalStatus: reported === "COMPLETED" ? "COMPLETED" : "FAILED" };
    }
    if (state?.phase === "settled") {
      // The tombstone remembers how it ended, so the answer says so instead of
      // defaulting a COMPLETED command to FAILED (review 2194). A tombstone
      // without a status (cancelled before start, or an older shape) still
      // answers without one, and the Platform is the authority then.
      return { outcome: "ALREADY_TERMINAL", ...(state.terminalStatus !== undefined ? { terminalStatus: state.terminalStatus } : {}) };
    }
    if (state?.phase === "cancelled-before-start") return { outcome: "CANCELLING", preRecorded: true };
    this.#states.set(commandId, { phase: "cancelled-before-start", at: this.now() });
    return { outcome: "CANCELLING", preRecorded: true };
  }

  /** Abort every running execution with a shared cause (shutdown, dead transport). */
  abortAll(cause: CommandStopCause): void {
    for (const state of this.#states.values()) {
      if (state.phase !== "executing") continue;
      state.cause = cause;
      state.abort.abort();
    }
  }

  /**
   * Commands this process still owes something: executing, reporting, or
   * holding an outcome the Platform has not acknowledged. A drain waits on
   * this, so neither a report in flight nor an undelivered one is mistaken for
   * an idle process.
   */
  get outstanding(): number {
    let n = 0;
    for (const state of this.#states.values()) {
      if (state.phase === "executing" || state.phase === "reporting" || state.phase === "unreported") n += 1;
    }
    return n;
  }

  /**
   * CLAIM every outcome whose retry is due now, and return them.
   *
   * Claiming moves each one to `reporting` (its attempt count kept), which is
   * what makes retries single-flight: a second driver arriving while the
   * first is still delivering finds nothing due, instead of sending the same
   * outcome twice and letting the slower attempt's failure overwrite the
   * faster one's success (review 2194). The claimant either settles it
   * (`reported`) or returns it to `unreported` (`reportFailed`).
   *
   * `all` ignores the backoff — used on shutdown, where there is no later.
   */
  claimDueRetries(all = false): { commandId: string; outcome: TerminalOutcome }[] {
    const owed: { commandId: string; outcome: TerminalOutcome }[] = [];
    const now = this.now();
    for (const [commandId, state] of this.#states) {
      if (state.phase !== "unreported") continue;
      if (all || state.nextAttemptAt <= now) {
        this.#states.set(commandId, { phase: "reporting", outcome: state.outcome, at: now, attempts: state.attempts });
        owed.push({ commandId, outcome: state.outcome });
      }
    }
    return owed;
  }

  /** Test seam: the phase of one command, or undefined if untracked. */
  phaseOf(commandId: string): CommandState["phase"] | undefined {
    return this.#states.get(commandId)?.phase;
  }

  /**
   * Drop tombstones past their TTL, then the OLDEST-SETTLED down to the cap.
   *
   * Eviction is ordered by settlement time, not by Map insertion order. Those
   * differ whenever a long-running command settles after a short one started
   * later: insertion order would offer that command's freshly written
   * tombstone first, and evicting it lets a redelivery re-run a side effect
   * that has only just happened (review 2188).
   *
   * Executing, reporting and unreported commands are never evicted — losing one
   * would reopen the duplicate-execution or lost-outcome hole this class exists
   * to close.
   */
  #evict(): void {
    const cutoff = this.now() - this.limits.settledTtlMs;
    for (const [id, state] of this.#states) {
      if ((state.phase === "settled" || state.phase === "cancelled-before-start") && state.at <= cutoff) this.#states.delete(id);
    }
    if (this.#states.size <= this.limits.maxTracked) return;
    const evictable: { id: string; at: number }[] = [];
    for (const [id, state] of this.#states) {
      if (state.phase === "settled" || state.phase === "cancelled-before-start") evictable.push({ id, at: state.at });
    }
    evictable.sort((a, b) => a.at - b.at);
    for (const { id } of evictable) {
      if (this.#states.size <= this.limits.maxTracked) break;
      this.#states.delete(id);
    }
  }
}

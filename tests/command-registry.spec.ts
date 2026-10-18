import { describe, expect, it } from "vitest";
import { CommandRegistry, DEFAULT_COMMAND_REGISTRY_LIMITS } from "../src/ce/command-registry";

describe("CommandRegistry: the states a presence-only map could not hold (review 2185)", () => {
  it("admits a first execution and refuses a concurrent duplicate", () => {
    const r = new CommandRegistry();
    expect(r.beginExecution("c1").admit).toBe(true);
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "already-running" });
  });

  it("refuses a redelivery after the command settled here", () => {
    const r = new CommandRegistry();
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    r.reported("c1");
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "already-settled" });
  });

  it("records a cancel that arrives before its execute, and refuses that execute", () => {
    const r = new CommandRegistry();
    expect(r.cancel("c1")).toMatchObject({ outcome: "CANCELLING", preRecorded: true });
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "cancelled-before-start" });
    // The refusal does NOT settle by itself any more: the caller owes the
    // Platform a CANCELLED outcome and must claim it (beginReporting) like any
    // other. Self-settling here made a failed delivery of that outcome a
    // silent drop (review 2194). Until the claim, a redelivery is refused the
    // same way; after it, like any other in-flight report.
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "cancelled-before-start" });
    r.beginReporting("c1", { status: "FAILED", failureReason: "CANCELLED" });
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "already-running" });
    r.reported("c1");
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "already-settled" });
  });

  it("aborts a running execution on cancel and marks the cause for the report", () => {
    const r = new CommandRegistry();
    const begun = r.beginExecution("c1");
    if (!begun.admit) throw new Error("expected admission");
    expect(r.cancel("c1")).toMatchObject({ outcome: "CANCELLING" });
    expect(begun.abort.signal.aborted).toBe(true);
    expect(r.beginReporting("c1", { status: "FAILED" })).toBe("CANCELLED");
  });

  it("says ALREADY_TERMINAL only once the command is settled or reporting", () => {
    const r = new CommandRegistry();
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    expect(r.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL" });
    r.reported("c1");
    expect(r.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL" });
  });

  it("counts a command reporting as outstanding, so a drain waits for it", () => {
    // Waiting only on execution let a process look idle while a terminal
    // outcome was still in flight; shutting down there lost the report and
    // left the Platform RUNNING for ever.
    const r = new CommandRegistry();
    r.beginExecution("c1");
    expect(r.outstanding).toBe(1);
    r.beginReporting("c1", { status: "COMPLETED" });
    expect(r.outstanding).toBe(1);
    r.reported("c1");
    expect(r.outstanding).toBe(0);
  });

  it("aborts everything running on shutdown, and the cause reaches the report", () => {
    const r = new CommandRegistry();
    const a = r.beginExecution("c1");
    const b = r.beginExecution("c2");
    if (!a.admit || !b.admit) throw new Error("expected admissions");
    r.abortAll("SHUTDOWN");
    expect(a.abort.signal.aborted).toBe(true);
    expect(b.abort.signal.aborted).toBe(true);
    expect(r.beginReporting("c1", { status: "FAILED" })).toBe("SHUTDOWN");
  });

  it("evicts tombstones by age but never work still owed", () => {
    let now = 1_000;
    const r = new CommandRegistry({ settledTtlMs: 100, maxTracked: 4_096, reportRetryBaseMs: 2_000, reportRetryMaxMs: 60_000 }, () => now);
    r.beginExecution("done");
    r.beginReporting("done", { status: "COMPLETED" });
    r.reported("done");
    r.beginExecution("busy"); // still executing
    now += 500;
    // The tombstone lapses, so this id is admissible again…
    expect(r.beginExecution("done").admit).toBe(true);
    // …while the running one is untouched: evicting it would reopen the
    // duplicate-execution hole.
    expect(r.beginExecution("busy")).toMatchObject({ admit: false, reason: "already-running" });
  });

  it("keeps the map bounded by dropping tombstones, not live work", () => {
    const r = new CommandRegistry({ settledTtlMs: 10 * 60_000, maxTracked: 8, reportRetryBaseMs: 2_000, reportRetryMaxMs: 60_000 });
    for (let i = 0; i < 50; i += 1) {
      r.beginExecution(`c${String(i)}`);
      r.beginReporting(`c${String(i)}`, { status: "COMPLETED" });
      r.reported(`c${String(i)}`);
    }
    r.beginExecution("live");
    expect(r.phaseOf("live")).toBe("executing");
    expect(r.outstanding).toBe(1);
  });
});

describe("a result frozen on the tombstone lives exactly as long as the tombstone (review 3196)", () => {
  it("a settlement that keeps a frozen result hands it back on the next beginExecution, and loses it with the tombstone under the cap", () => {
    let now = 1_000;
    const registry = new CommandRegistry({ ...DEFAULT_COMMAND_REGISTRY_LIMITS, maxTracked: 2 }, () => now);
    expect(registry.beginExecution("rv-1").admit).toBe(true);
    registry.settleWithoutReport("rv-1", "COMPLETED", { inputSchema: {}, initialPayload: {}, currentState: { card: 1 } });
    // Same command id: the SAME frozen result, no re-run.
    expect(registry.beginExecution("rv-1")).toEqual({ admit: false, reason: "already-settled", frozen: { inputSchema: {}, initialPayload: {}, currentState: { card: 1 } } });
    // A settlement without a result freezes nothing.
    expect(registry.beginExecution("rv-2").admit).toBe(true);
    registry.settleWithoutReport("rv-2", "FAILED");
    expect(registry.beginExecution("rv-2")).toEqual({ admit: false, reason: "already-settled" });
    // Two more settlements push the map past the cap: the OLDEST tombstone —
    // and its frozen result with it — is gone, so rv-1 is a fresh command
    // again (the execute door's own semantics), never a frozen-less tombstone.
    now += 1;
    expect(registry.beginExecution("rv-3").admit).toBe(true);
    registry.settleWithoutReport("rv-3", "COMPLETED", { inputSchema: {}, initialPayload: {}, currentState: { card: 3 } });
    now += 1;
    expect(registry.beginExecution("rv-4").admit).toBe(true);
    registry.settleWithoutReport("rv-4", "COMPLETED");
    expect(registry.phaseOf("rv-1")).toBeUndefined();
    expect(registry.beginExecution("rv-1").admit).toBe(true);
    expect(registry.beginExecution("rv-4")).toEqual({ admit: false, reason: "already-settled" });
  });
});

describe("execute once, replay the outcome until it is accepted (review 2188)", () => {
  it("keeps a command owed when its report failed, and replays instead of re-running", () => {
    // Settling on report failure was the same mistake one step later than the
    // one this class was written to fix: the Platform stays RUNNING while the
    // tombstone guarantees the command will neither run nor be reported again.
    const r = new CommandRegistry();
    const begun = r.beginExecution("c1");
    if (!begun.admit) throw new Error("expected admission");
    r.beginReporting("c1", { status: "COMPLETED", result: { ok: true } });
    r.reportFailed("c1", { status: "COMPLETED", result: { ok: true } });
    expect(r.phaseOf("c1")).toBe("unreported");

    // A redelivery hands back the outcome — the action is NOT run again,
    // because its effect already happened.
    const again = r.beginExecution("c1");
    expect(again).toMatchObject({ admit: false, reason: "replay-outcome" });
    if (again.admit || again.reason !== "replay-outcome") throw new Error("expected a replay");
    expect(again.outcome).toEqual({ status: "COMPLETED", result: { ok: true } });
  });

  it("counts an unacknowledged outcome as work still owed", () => {
    const r = new CommandRegistry();
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    r.reportFailed("c1", { status: "COMPLETED" });
    expect(r.outstanding).toBe(1);
    expect(r.claimDueRetries(true)).toEqual([{ commandId: "c1", outcome: { status: "COMPLETED" } }]);
    r.reported("c1");
    expect(r.outstanding).toBe(0);
    expect(r.claimDueRetries(true)).toEqual([]);
  });

  it("never evicts a command still holding an undelivered outcome", () => {
    let now = 1_000;
    const r = new CommandRegistry({ settledTtlMs: 100, maxTracked: 2, reportRetryBaseMs: 2_000, reportRetryMaxMs: 60_000 }, () => now);
    r.beginExecution("owed");
    r.beginReporting("owed", { status: "COMPLETED" });
    r.reportFailed("owed", { status: "COMPLETED" });
    now += 10_000;
    for (let i = 0; i < 20; i += 1) {
      r.beginExecution(`c${String(i)}`);
      r.beginReporting(`c${String(i)}`, { status: "COMPLETED" });
      r.reported(`c${String(i)}`);
    }
    expect(r.phaseOf("owed")).toBe("unreported");
  });

  it("evicts by settlement time, not by when the command first arrived", () => {
    // Insertion order and settlement order differ whenever a long command
    // settles after a short one that started later. A Map keeps a key at its
    // ORIGINAL position when its value is replaced, so the long command's
    // freshly written tombstone sits first — and evicting by iteration order
    // throws away the newest settlement, letting a redelivery re-run a side
    // effect that has only just happened.
    let now = 1_000;
    const r = new CommandRegistry({ settledTtlMs: 10 * 60_000, maxTracked: 2, reportRetryBaseMs: 2_000, reportRetryMaxMs: 60_000 }, () => now);

    r.beginExecution("long"); // arrives first, finishes last

    now += 10;
    r.beginExecution("early");
    r.beginReporting("early", { status: "COMPLETED" });
    r.reported("early"); // settles at 1010 — the OLDEST settlement

    now += 10;
    r.beginReporting("long", { status: "COMPLETED" });
    r.reported("long"); // settles at 1020 — the NEWEST, but first in Map order

    // A third settled entry pushes past the cap of 2, forcing one eviction
    // while all three are tombstones.
    now += 10;
    r.beginExecution("later");
    r.beginReporting("later", { status: "COMPLETED" });
    r.reported("later");

    // The oldest settlement goes; the newest survives. Evicting by iteration
    // order would have done the opposite.
    expect(r.phaseOf("early")).toBeUndefined();
    expect(r.beginExecution("long")).toMatchObject({ admit: false, reason: "already-settled" });
  });

  it("settles without a report where the response IS the report", () => {
    // A synchronous transport owes nothing once the caller holds the answer.
    const r = new CommandRegistry();
    r.beginExecution("c1");
    r.settleWithoutReport("c1");
    expect(r.outstanding).toBe(0);
    expect(r.beginExecution("c1")).toMatchObject({ admit: false, reason: "already-settled" });
  });

  it("treats a cancel for an owed outcome as already terminal", () => {
    const r = new CommandRegistry();
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    r.reportFailed("c1", { status: "COMPLETED" });
    // The action is over and its outcome decided; there is nothing to stop.
    expect(r.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL" });
  });
});

describe("the terminal outcome has its own delivery lifecycle (review 2191)", () => {
  const limits = { settledTtlMs: 10 * 60_000, maxTracked: 64, reportRetryBaseMs: 1_000, reportRetryMaxMs: 8_000 };

  it("backs off between attempts, and holds at the ceiling rather than giving up", () => {
    let now = 0;
    const r = new CommandRegistry(limits, () => now);
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });

    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      r.reportFailed("c1", { status: "COMPLETED" });
      // Not due yet…
      expect(r.claimDueRetries()).toEqual([]);
      // …find the delay by advancing until it is. The successful probe CLAIMS
      // the retry (that is the 2194 single-flight rule), which is also what
      // re-arms reportFailed for the next loop iteration.
      let waited = 0;
      while (r.claimDueRetries().length === 0) {
        now += 100;
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    // Held, never abandoned: a command the Platform never learns about needs a
    // human to cancel it, so retrying beats surrendering.
    expect(delays.slice(4)).toEqual([8_000, 8_000]);
  });

  it("shutdown retries everything owed, backoff or not", () => {
    let now = 0;
    const r = new CommandRegistry(limits, () => now);
    for (const id of ["a", "b"]) {
      r.beginExecution(id);
      r.beginReporting(id, { status: "COMPLETED" });
      r.reportFailed(id, { status: "COMPLETED" });
    }
    expect(r.claimDueRetries()).toEqual([]); // none due on the clock
    expect(r.claimDueRetries(true)).toHaveLength(2); // but there is no later
  });

  it("says how an already-terminal command actually finished", () => {
    // The cancel response's ALREADY_TERMINAL arm carries a terminal status.
    // Hardcoding FAILED described a COMPLETED command as failed.
    const done = new CommandRegistry(limits);
    done.beginExecution("c1");
    done.beginReporting("c1", { status: "COMPLETED", result: { ok: true } });
    expect(done.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "COMPLETED" });

    const failed = new CommandRegistry(limits);
    failed.beginExecution("c2");
    failed.beginReporting("c2", { status: "FAILED", errorCode: "ACTION_FAILED" });
    expect(failed.cancel("c2")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "FAILED" });
  });

  it("a slow attempt's failure cannot regress a command another attempt settled", () => {
    // The 2194 P1: attempts A and B both hold the same outcome; A succeeds and
    // settles; B fails afterwards. reportFailed used to write the settled
    // command straight back to unreported — a terminal-state regression that
    // re-sent an outcome the Platform had already accepted.
    const r = new CommandRegistry(limits);
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    r.reported("c1"); // A wins
    r.reportFailed("c1", { status: "COMPLETED" }); // B, late and failed
    expect(r.phaseOf("c1")).toBe("settled");
    expect(r.outstanding).toBe(0);
    expect(r.claimDueRetries(true)).toEqual([]);
  });

  it("claiming makes retries single-flight, and a failed claim resumes its backoff", () => {
    let now = 0;
    const r = new CommandRegistry(limits, () => now);
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED" });
    r.reportFailed("c1", { status: "COMPLETED" }); // attempt 1 failed -> due at +1000
    now = 1_000;
    // Two drivers race one due retry: the first claims it, the second finds
    // nothing — that is what stops overlapping attempts existing at all.
    expect(r.claimDueRetries()).toHaveLength(1);
    expect(r.claimDueRetries()).toEqual([]);
    expect(r.claimDueRetries(true)).toEqual([]); // even a drain cannot double-claim
    // The claimed attempt fails too: backoff continues from where it was
    // (attempt 2 -> 2000ms), not from the beginning.
    r.reportFailed("c1", { status: "COMPLETED" });
    now = 2_999;
    expect(r.claimDueRetries()).toEqual([]);
    now = 3_000;
    expect(r.claimDueRetries()).toHaveLength(1);
  });

  it("the settled tombstone still says how the command ended", () => {
    // The 2194 gap: ALREADY_TERMINAL after settlement lost the status, so a
    // genuinely COMPLETED command was answered as FAILED off the bare
    // tombstone.
    const r = new CommandRegistry(limits);
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED", result: { ok: true } });
    r.reported("c1");
    expect(r.phaseOf("c1")).toBe("settled");
    expect(r.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "COMPLETED" });
    // Synchronous transport settles the same way, with the caller saying how.
    const sync = new CommandRegistry(limits);
    sync.beginExecution("c2");
    sync.settleWithoutReport("c2", "COMPLETED");
    expect(sync.cancel("c2")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "COMPLETED" });
  });

  it("the Platform's canonical status wins over the local report in the tombstone", () => {
    // ALREADY_TERMINAL means the Platform had already settled this command —
    // possibly differently from what was just reported. The tombstone answers
    // later cancels, so remembering the LOCAL value contradicted the
    // authority: local COMPLETED, Platform already FAILED, tombstone claimed
    // COMPLETED (review 2201).
    const r = new CommandRegistry(limits);
    r.beginExecution("c1");
    r.beginReporting("c1", { status: "COMPLETED", result: { ok: true } });
    r.reported("c1", "FAILED"); // the Platform's answer named FAILED
    expect(r.cancel("c1")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "FAILED" });
    // Without a canonical status (APPLIED took the local report as-is), the
    // local value is what the tombstone holds — same as before.
    const applied = new CommandRegistry(limits);
    applied.beginExecution("c2");
    applied.beginReporting("c2", { status: "COMPLETED" });
    applied.reported("c2");
    expect(applied.cancel("c2")).toMatchObject({ outcome: "ALREADY_TERMINAL", terminalStatus: "COMPLETED" });
  });
});

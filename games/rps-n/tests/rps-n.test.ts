import { describe, expect, test } from "bun:test";
import { appendEvent, mkSeatId, verifyReplay } from "@benchboss/core";
import type { LogEvent, MatchConfig, SeatId } from "@benchboss/core";
import { RPS_PHASE_TOOLS, makeRpsN } from "../src";
import type { RpsState, Throw } from "../src";

function cfg(rounds: number, n = 2): MatchConfig {
  return {
    matchId: "m1",
    gameId: "rps-n",
    seats: Array.from({ length: n }, (_, i) => mkSeatId(i)),
    rules: { rounds },
    budgets: {
      wallClockMsPerDecision: 5000,
      toolCallsPerTurn: 3,
      intelOrScoutPoints: 0,
      simRolloutsPerTurn: 0,
      invalidRetries: 1,
    },
  };
}

describe("rps-n reference game", () => {
  test("id_is_rps_n_and_starts_in_throw_phase", () => {
    const g = makeRpsN();
    const s = g.newMatch(cfg(3), "seed");
    expect(g.id).toBe("rps-n");
    expect(s.phase).toBe("throw");
    expect(s.round).toBe(0);
  });

  test("legal_actions_advertise_match_throw_in_throw_phase", () => {
    const g = makeRpsN();
    const s = g.newMatch(cfg(3), "seed");
    const legal = g.legalActions(s, mkSeatId(0));
    expect(legal.map((l) => l.tool)).toEqual(["match.throw"]);
    const first = legal[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("first is undefined");
    expect(first.jsonSchema.additionalProperties).toBe(false);
  });

  test("submit_records_throw_and_rejects_second_commit", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(3), "seed");
    const r1 = g.submit(s, mkSeatId(0), { throw: "rock" });
    expect(r1.accepted).toBe(true);
    s = r1.state;
    const r2 = g.submit(s, mkSeatId(0), { throw: "paper" });
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toContain("already");
  });

  test("submit_rejects_when_not_in_throw_phase", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(1), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }).state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }).state;
    s = g.step(s); // resolves to terminal
    const r = g.submit(s, mkSeatId(0), { throw: "rock" });
    expect(r.accepted).toBe(false);
  });

  test("step_scores_rock_beats_scissors_pairwise", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(1), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }).state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }).state;
    s = g.step(s);
    expect(g.isTerminal(s)).toBe(true);
    expect(g.score(s)[mkSeatId(0)]).toBe(1);
    expect(g.score(s)[mkSeatId(1)]).toBe(0);
  });

  test("observe_leaks_nothing_about_other_seats_committed_throw", () => {
    // Seat 0 throws rock; seat 1 has committed scissors but not revealed.
    const g = makeRpsN();
    let s = g.newMatch(cfg(3), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }).state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }).state;
    const obsForA = g.observe(s, mkSeatId(0));
    // A may see ONLY its own throw; B's throw must not appear anywhere in A's observation.
    const serialized = JSON.stringify(obsForA);
    expect(serialized).not.toContain("scissors");
    expect(obsForA.privateState.yourThrow).toBe("rock");
    // committedSeats may name that seat:1 committed, but not WHAT.
    expect(obsForA.publicState.committedSeats).toContain("seat:1");
  });

  test("observe_for_uncommitted_seat_reveals_no_throw", () => {
    const g = makeRpsN();
    const s = g.newMatch(cfg(3), "seed");
    const obs = g.observe(s, mkSeatId(0));
    expect(obs.privateState.yourThrow).toBeNull();
  });

  test("legalActions_returns_no_moves_for_a_seat_that_already_committed", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(3), "seed");
    // Seat 0 commits its throw; seat 1 has not yet committed.
    const r = g.submit(s, mkSeatId(0), { throw: "rock" });
    expect(r.accepted).toBe(true);
    s = r.state;
    // Committed seat gets no legal actions.
    const legalCommitted = g.legalActions(s, mkSeatId(0));
    expect(legalCommitted).toEqual([]);
    // Not-yet-committed seat still gets the throw action.
    const legalPending = g.legalActions(s, mkSeatId(1));
    expect(legalPending).toBeDefined();
    expect(legalPending.length).toBe(1);
    const action = legalPending[0];
    expect(action).toBeDefined();
    if (action === undefined) throw new Error("action is undefined");
    expect(action.tool).toBe("match.throw");
  });

  test("full_match_replays_to_byte_identical_terminal_state", () => {
    // Drive a 2-round match, log every action+resolve+terminal, then verify.
    const g = makeRpsN();
    const config = cfg(2);
    let events: readonly LogEvent[] = [];
    let s: RpsState = g.newMatch(config, "seed-xyz");
    const script: Array<[number, Throw]> = [
      [0, "rock"],
      [1, "scissors"],
      [0, "paper"],
      [1, "rock"],
    ];
    let i = 0;
    while (!g.isTerminal(s)) {
      for (const seat of config.seats) {
        const row = script[i++];
        expect(row).toBeDefined();
        if (row === undefined) throw new Error("script ran out of rows");
        const [, t] = row;
        const res = g.submit(s, seat, { throw: t });
        expect(res.accepted).toBe(true);
        s = res.state;
        events = appendEvent(events, {
          matchId: "m1",
          phase: "throw",
          seat,
          kind: "action.submit",
          payload: { action: { throw: t } },
        });
      }
      s = g.step(s);
      events = appendEvent(events, {
        matchId: "m1",
        phase: "throw",
        seat: null,
        kind: "phase.resolve",
        payload: {},
      });
    }
    events = appendEvent(events, {
      matchId: "m1",
      phase: "terminal",
      seat: null,
      kind: "match.terminal",
      payload: { score: g.score(s) },
    });

    const res = verifyReplay({
      game: g,
      config,
      seed: "seed-xyz",
      log: [...events],
    });
    expect(res.ok).toBe(true);
  });
});

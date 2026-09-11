import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import type { MatchConfig } from "@benchboss/core";
import { gameConfig } from "../../tests/config";
import { makeRpsN } from "../src";
import type { Throw } from "../src";
import { plugin } from "../src/plugin";

function cfg(rounds: number, n = 2): MatchConfig {
  return gameConfig(
    plugin.manifest,
    "m1",
    Array.from({ length: n }, (_, i) => mkSeatId(i)),
    { rounds },
  );
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

  test("a valid throw cannot execute under a different or missing tool", () => {
    const game = makeRpsN();
    const state = game.newMatch(cfg(1), "tools");
    for (const tool of ["unknown", undefined]) {
      const submitted = game.submit(state, mkSeatId(0), { throw: "rock" }, tool as string);
      expect(submitted.accepted).toBe(false);
      expect(submitted.state).toBe(state);
    }
  });

  test("submit_records_throw_and_rejects_second_commit", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(3), "seed");
    const r1 = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw");
    expect(r1.accepted).toBe(true);
    s = r1.state;
    const r2 = g.submit(s, mkSeatId(0), { throw: "paper" }, "match.throw");
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toContain("already");
  });

  test("submit_rejects_when_not_in_throw_phase", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(1), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw").state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }, "match.throw").state;
    s = g.step(s); // resolves to terminal
    const r = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw");
    expect(r.accepted).toBe(false);
  });

  test("step_scores_rock_beats_scissors_pairwise", () => {
    const g = makeRpsN();
    let s = g.newMatch(cfg(1), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw").state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }, "match.throw").state;
    s = g.step(s);
    expect(g.isTerminal(s)).toBe(true);
    expect(g.score(s)[mkSeatId(0)]).toBe(1);
    expect(g.score(s)[mkSeatId(1)]).toBe(0);
  });

  test("observe_leaks_nothing_about_other_seats_committed_throw", () => {
    // Seat 0 throws rock; seat 1 has committed scissors but not revealed.
    const g = makeRpsN();
    let s = g.newMatch(cfg(3), "seed");
    s = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw").state;
    s = g.submit(s, mkSeatId(1), { throw: "scissors" }, "match.throw").state;
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
    const r = g.submit(s, mkSeatId(0), { throw: "rock" }, "match.throw");
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

  test("the same action script produces identical terminal game state", () => {
    const game = makeRpsN();
    const config = cfg(2);
    const script: Throw[][] = [
      ["rock", "scissors"],
      ["paper", "rock"],
    ];
    function play() {
      let state = game.newMatch(config, "seed-xyz");
      for (const round of script) {
        for (const [index, seat] of config.seats.entries()) {
          const move = round[index];
          if (!move) throw Error("missing scripted throw");
          const submitted = game.submit(state, seat, { throw: move }, "match.throw");
          expect(submitted.accepted).toBe(true);
          state = submitted.state;
        }
        state = game.step(state);
      }
      expect(game.isTerminal(state)).toBe(true);
      expect(game.score(state)).toEqual({ [mkSeatId(0)]: 2, [mkSeatId(1)]: 0 });
      return state;
    }
    expect(play()).toEqual(play());
  });
});

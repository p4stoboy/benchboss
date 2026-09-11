import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import type { Role, SpyPhase, SpyState } from "../src/types";

describe("spy types", () => {
  test("constructs_an_empty_spy_state_with_briefing_phase", () => {
    const seats = [0, 1, 2, 3, 4].map(mkSeatId);
    const state: SpyState = {
      matchId: "m1",
      seats,
      deal: {
        roleBySeat: {},
        alignmentBySeat: {},
        moleSeats: [],
        knownMolesBySeat: {},
        handlerSeat: null,
        deepCoverSeat: null,
      },
      phase: "briefing",
      round: 0,
      opIndex: 0,
      leaderIdx: 0,
      rejectStreak: 0,
      successes: 0,
      fails: 0,
      proposal: null,
      votes: {},
      missionActions: [],
      opResults: [],
      log: [],
      intelResults: {},
      commsCountThisRound: {},
      phaseEnded: {},
      winner: null,
      winReason: "",
      nextActSeq: 0,
      assassinGuess: null,
      misinfoFlags: {},
      protectedSources: [],
    };
    expect(state.phase).toBe<SpyPhase>("briefing");
    expect(state.seats.length).toBe(5);
    const r: Role = "mole";
    expect(r).toBe("mole");
  });
});

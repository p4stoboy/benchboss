import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import type { SpyState } from "../src/types";
import { evaluateWin } from "../src/win";

function blankState(over: Partial<SpyState> = {}): SpyState {
  return {
    matchId: "m",
    seats: [0, 1, 2, 3, 4].map(mkSeatId),
    deal: {
      roleBySeat: {},
      alignmentBySeat: {},
      moleSeats: [],
      knownMolesBySeat: {},
      handlerSeat: null,
      deepCoverSeat: null,
    },
    phase: "debrief",
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
    ...over,
  };
}

describe("evaluateWin", () => {
  test("loyal_win_on_three_successful_ops", () => {
    const r = evaluateWin(blankState({ successes: 3 }));
    expect(r).toEqual({
      over: true,
      winner: "loyal",
      reason: "three-successful-ops",
    });
  });
  test("mole_win_on_three_failed_ops", () => {
    const r = evaluateWin(blankState({ fails: 3 }));
    expect(r).toEqual({
      over: true,
      winner: "mole",
      reason: "three-failed-ops",
    });
  });
  test("mole_win_on_five_consecutive_rejections", () => {
    const r = evaluateWin(blankState({ rejectStreak: 5 }));
    expect(r).toEqual({ over: true, winner: "mole", reason: "hammer" });
  });
  test("not_over_mid_game", () => {
    const r = evaluateWin(blankState({ successes: 1, fails: 1, rejectStreak: 2 }));
    expect(r.over).toBe(false);
    expect(r.winner).toBeNull();
  });
});

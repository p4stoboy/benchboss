import { describe, expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import { MISSION_FAIL_THRESHOLDS, MISSION_TEAM_SIZES } from "../src/missions";
import { SPY_ROLE_TABLE, dealRoles } from "../src/roles";
import { runSpyMatch } from "./harness";

describe("M4 larger tables", () => {
  test("seven_seat_deal_has_four_loyal_three_mole", () => {
    const seats = Array.from({ length: 7 }, (_, i) => mkSeatId(i));
    const deal = dealRoles(seats, createRng("t7"));
    const moles = seats.filter((s) => deal.alignmentBySeat[s] === "mole");
    expect(moles.length).toBe(3);
    expect(SPY_ROLE_TABLE[7]).toEqual({ loyal: 4, mole: 3 });
  });

  test("nine_seat_deal_has_six_loyal_three_mole", () => {
    const seats = Array.from({ length: 9 }, (_, i) => mkSeatId(i));
    const deal = dealRoles(seats, createRng("t9"));
    const moles = seats.filter((s) => deal.alignmentBySeat[s] === "mole");
    expect(moles.length).toBe(3);
    const loyals = seats.filter((s) => deal.alignmentBySeat[s] === "loyal");
    expect(loyals.length).toBe(6);
    expect(SPY_ROLE_TABLE[9]).toEqual({ loyal: 6, mole: 3 });
  });

  test("seven_seat_fourth_mission_requires_two_sabotages", () => {
    expect(MISSION_TEAM_SIZES[7]).toBeDefined();
    const teamSizes7 = MISSION_TEAM_SIZES[7];
    if (teamSizes7 === undefined) throw new Error("unreachable");
    expect(teamSizes7.length).toBe(5);
    expect(MISSION_FAIL_THRESHOLDS[7]).toBeDefined();
    const thresholds7 = MISSION_FAIL_THRESHOLDS[7];
    if (thresholds7 === undefined) throw new Error("unreachable");
    expect(thresholds7[3]).toBe(2);
    expect(MISSION_FAIL_THRESHOLDS[9]).toBeDefined();
    const thresholds9 = MISSION_FAIL_THRESHOLDS[9];
    if (thresholds9 === undefined) throw new Error("unreachable");
    expect(thresholds9[3]).toBe(2);
  });

  test("a_seven_seat_match_plays_to_a_winner", () => {
    const { score } = runSpyMatch({ seed: "seven-seed", seats: 7 });
    // score[seat] === 1 if that seat's alignment === winning faction, else 0.
    // At 7 seats: loyal faction has 4 seats, mole faction has 3 seats.
    // A real win means exactly one faction's seats all score 1.
    const winners = Object.values(score).filter((v) => v === 1);
    expect(winners.length).toBeGreaterThan(0);
    expect(winners.length === 4 || winners.length === 3).toBe(true);
  });
});

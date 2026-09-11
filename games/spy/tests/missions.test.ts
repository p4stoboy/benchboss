import { describe, expect, test } from "bun:test";
import { MISSION_TEAM_SIZES, failThreshold, teamSize } from "../src/missions";

describe("mission tables", () => {
  test("five_seat_op_zero_needs_two_members", () => {
    expect(teamSize(5, 0)).toBe(2);
  });
  test("five_seat_one_sabotage_fails_any_op", () => {
    expect(failThreshold(5, 0)).toBe(1);
    expect(failThreshold(5, 3)).toBe(1);
  });
  test("seven_seat_fourth_op_needs_two_sabotages", () => {
    expect(failThreshold(7, 3)).toBe(2);
  });
  test("table_has_five_ops_per_seat_count", () => {
    const row = MISSION_TEAM_SIZES[5];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("row must be defined");
    expect(row.length).toBe(5);
  });
  test("nine_seat_fourth_op_needs_two_sabotages", () => {
    expect(failThreshold(9, 3)).toBe(2);
  });
  test("nine_seat_mission_team_sizes", () => {
    expect(teamSize(9, 0)).toBe(3);
    expect(teamSize(9, 4)).toBe(5);
  });
  test("teamSize_throws_on_unknown_seat_count", () => {
    expect(() => teamSize(6, 0)).toThrow();
  });
  test("teamSize_throws_on_out_of_range_op_index", () => {
    expect(() => teamSize(5, 5)).toThrow();
  });
});

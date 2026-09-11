import { describe, expect, test } from "bun:test";
import { initRating, mkSeatId, ratingTable, recordResult } from "../src/index";
import type { SeatId } from "../src/index";

const seatToAgent = {
  [mkSeatId(0)]: "alice",
  [mkSeatId(1)]: "bob",
  [mkSeatId(2)]: "carol",
} as Record<SeatId, string>;

describe("points rating", () => {
  test("table_is_ordered_by_points_then_win_rate_then_name", () => {
    let state = initRating(seatToAgent);
    state = recordResult(state, { [mkSeatId(0)]: 3, [mkSeatId(1)]: 1, [mkSeatId(2)]: 0 } as Record<
      SeatId,
      number
    >);
    state = recordResult(state, { [mkSeatId(0)]: 3, [mkSeatId(1)]: 2, [mkSeatId(2)]: 1 } as Record<
      SeatId,
      number
    >);
    const table = ratingTable(state);
    expect(table.map((row) => row.agent)).toEqual(["alice", "bob", "carol"]);
    expect(table[0]?.points).toBe(6);
  });

  test("win_rate_counts_max_placement_as_a_win", () => {
    let state = initRating(seatToAgent);
    state = recordResult(state, { [mkSeatId(0)]: 5, [mkSeatId(1)]: 1, [mkSeatId(2)]: 1 } as Record<
      SeatId,
      number
    >);
    state = recordResult(state, { [mkSeatId(0)]: 0, [mkSeatId(1)]: 4, [mkSeatId(2)]: 1 } as Record<
      SeatId,
      number
    >);
    const table = ratingTable(state);
    const alice = table.find((row) => row.agent === "alice");
    expect(alice?.winRate).toBeCloseTo(0.5, 10);
  });

  test("tie_for_max_counts_as_win_for_all_maxima", () => {
    let state = initRating(seatToAgent);
    state = recordResult(state, { [mkSeatId(0)]: 2, [mkSeatId(1)]: 2, [mkSeatId(2)]: 0 } as Record<
      SeatId,
      number
    >);
    const table = ratingTable(state);
    expect(table.find((row) => row.agent === "alice")?.winRate).toBe(1);
    expect(table.find((row) => row.agent === "bob")?.winRate).toBe(1);
    expect(table.find((row) => row.agent === "carol")?.winRate).toBe(0);
  });

  test("openskill_fields_absent_by_default_present_when_enabled", () => {
    let off = initRating(seatToAgent);
    off = recordResult(off, {
      [mkSeatId(0)]: 3,
      [mkSeatId(1)]: 1,
      [mkSeatId(2)]: 0,
    } as Record<SeatId, number>);
    expect(ratingTable(off)[0]?.openskillMu).toBeUndefined();

    let on = initRating(seatToAgent, { openskill: true });
    on = recordResult(on, {
      [mkSeatId(0)]: 3,
      [mkSeatId(1)]: 1,
      [mkSeatId(2)]: 0,
    } as Record<SeatId, number>);
    expect(ratingTable(on)[0]?.openskillMu).toBeTypeOf("number");
    expect(ratingTable(on)[0]?.openskillSigma).toBeTypeOf("number");
  });
});

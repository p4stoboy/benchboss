import { describe, expect, test } from "bun:test";
import { mkSeatId } from "../src/index";
import type { BudgetConfig, MatchConfig, SeatId } from "../src/index";

describe("contract types", () => {
  test("mkSeatId_produces_opaque_seat_string", () => {
    const s: SeatId = mkSeatId(0);
    expect(s).toBe("seat:0" as SeatId);
  });

  test("mkSeatId_is_stable_for_index", () => {
    expect(mkSeatId(3)).toBe("seat:3" as SeatId);
  });

  test("match_config_shape_is_constructible", () => {
    const budgets: BudgetConfig = {
      wallClockMsPerDecision: 5000,
      toolCallsPerTurn: 8,
      intelOrScoutPoints: 3,
      simRolloutsPerTurn: 16,
      invalidRetries: 1,
    };
    const cfg: MatchConfig = {
      matchId: "m1",
      gameId: "rps-n",
      seats: [mkSeatId(0), mkSeatId(1)],
      rules: { rounds: 3 },
      budgets,
    };
    expect(cfg.seats).toHaveLength(2);
    expect(cfg.budgets.invalidRetries).toBe(1);
  });
});

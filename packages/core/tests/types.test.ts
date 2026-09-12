import { describe, expect, test } from "bun:test";
import { mkSeatId } from "../src/index";
import type { MatchConfig, SeatId } from "../src/index";

describe("contract types", () => {
  test("mkSeatId_produces_opaque_seat_string", () => {
    const s: SeatId = mkSeatId(0);
    expect(s).toBe("seat:0" as SeatId);
  });

  test("mkSeatId_is_stable_for_index", () => {
    expect(mkSeatId(3)).toBe("seat:3" as SeatId);
  });

  test("match_config_shape_is_constructible", () => {
    const cfg: MatchConfig = {
      matchId: "m1",
      gameId: "rps-n",
      seats: [mkSeatId(0), mkSeatId(1)],
      rules: { rounds: 3 },
      identity: {
        protocolVersion: 1,
        runtimeVersion: "0.1.0",
        gameId: "rps-n",
        revision: "1.0.0",
      },
      timing: {
        playerTotalMs: null,
        decisionLimitMs: 5000,
        phaseLimits: {},
        clockVisibility: "private",
      },
      resources: { retries: { amount: 1, reset: "match", visibility: "private" } },
      metering: { invalidAction: { resource: "retries", cost: 1 } },
    };
    expect(cfg.seats).toHaveLength(2);
    expect(cfg.identity.protocolVersion).toBe(1);
    expect(cfg.resources.retries?.amount).toBe(1);
  });
});

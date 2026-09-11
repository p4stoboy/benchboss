import { type MatchConfig, mkSeatId } from "@benchboss/core";
import { SPY_GAME_ID } from "../src/game";

export function baseConfig(rounds = 5): MatchConfig {
  return {
    matchId: "m1",
    gameId: SPY_GAME_ID,
    seats: [0, 1, 2, 3, 4].map(mkSeatId),
    rules: { rounds },
    budgets: {
      wallClockMsPerDecision: 1000,
      toolCallsPerTurn: 8,
      intelOrScoutPoints: 3,
      simRolloutsPerTurn: 0,
      invalidRetries: 2,
    },
  };
}

export function handlerConfig(rounds = 5): MatchConfig {
  const base = baseConfig(rounds);
  return { ...base, rules: { ...base.rules, handler: true } };
}

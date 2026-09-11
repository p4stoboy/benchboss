import { describe, expect, test } from "bun:test";
import { initRating, ratingTable, recordResult, scheduleTournament } from "@benchboss/core";
import type { BudgetConfig, MatchConfig, SeatId } from "@benchboss/core";
import { makeRpsN } from "../src";
import type { RpsState, Throw } from "../src";

const budgets: BudgetConfig = {
  wallClockMsPerDecision: 5000,
  toolCallsPerTurn: 3,
  intelOrScoutPoints: 0,
  simRolloutsPerTurn: 0,
  invalidRetries: 1,
};

// Deterministic fixed-policy agents so the smoke result is stable.
const policy: Record<string, Throw> = {
  alwaysRock: "rock",
  alwaysPaper: "paper",
};

function playMatch(config: MatchConfig): Record<SeatId, number> {
  const g = makeRpsN();
  let s: RpsState = g.newMatch(config, (config.rules.seed as string) ?? "s");
  const assignment = config.rules.seatAssignment as string[];
  while (!g.isTerminal(s)) {
    config.seats.forEach((seat, idx) => {
      const agentName = assignment[idx];
      expect(agentName).toBeDefined();
      const throwValue = policy[agentName as string];
      expect(throwValue).toBeDefined();
      s = g.submit(s, seat, { throw: throwValue as Throw }).state;
    });
    s = g.step(s);
  }
  return g.score(s);
}

describe("rps-n tournament and rating smoke", () => {
  test("rotation_lets_each_agent_play_each_seat_and_rating_table_orders_winner_first", () => {
    const matches = scheduleTournament(budgets, {
      agents: ["alwaysRock", "alwaysPaper"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"], // even multiple of 2 agents => balanced
      rotateSeatsAndRoles: true,
    });
    // Build a per-match seat->agent map and a rating instance per match's seating.
    let paperPoints = 0;
    let rockPoints = 0;
    for (const m of matches) {
      const assignment = m.rules.seatAssignment as string[];
      const seatToAgent = {} as Record<SeatId, string>;
      m.seats.forEach((seat, idx) => {
        const agentName = assignment[idx];
        expect(agentName).toBeDefined();
        seatToAgent[seat] = agentName as string;
      });
      let rating = initRating(seatToAgent);
      rating = recordResult(rating, playMatch(m));
      for (const row of ratingTable(rating)) {
        if (row.agent === "alwaysPaper") paperPoints += row.points;
        if (row.agent === "alwaysRock") rockPoints += row.points;
      }
    }
    // Paper beats rock every round across both seatings => paper strictly ahead.
    expect(paperPoints).toBe(6);
    expect(rockPoints).toBe(0);
  });

  test("seat_rotation_is_balanced_over_the_batch", () => {
    const matches = scheduleTournament(budgets, {
      agents: ["alwaysRock", "alwaysPaper"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"],
      rotateSeatsAndRoles: true,
    });
    const seat0Agents = matches.map((m) => (m.rules.seatAssignment as string[])[0]);
    expect(new Set(seat0Agents).size).toBe(2); // both agents took seat 0 once
  });
});

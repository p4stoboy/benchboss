import { describe, expect, test } from "bun:test";
import { initRating, ratingTable, recordResult, scheduleTournament } from "@benchboss/core";
import type { ScheduledMatch, SeatId } from "@benchboss/core";
import { makeRpsN } from "../src";
import type { RpsState, Throw } from "../src";
import { plugin } from "../src/plugin";

const policyConfig = {
  identity: {
    protocolVersion: 1 as const,
    runtimeVersion: "0.1.0" as const,
    gameId: plugin.id,
    revision: plugin.manifest.revision,
  },
  timing: plugin.manifest.defaultTiming,
  resources: plugin.manifest.defaultResources,
  metering: plugin.manifest.defaultMetering,
};

// Deterministic fixed-policy agents so the smoke result is stable.
const policy: Record<string, Throw> = {
  alwaysRock: "rock",
  alwaysPaper: "paper",
};

function playMatch(scheduled: ScheduledMatch): Record<SeatId, number> {
  const config = scheduled.config;
  const g = makeRpsN();
  let s: RpsState = g.newMatch(config, scheduled.seed);
  const assignment = scheduled.assignments.map((row) => row.agentId);
  while (!g.isTerminal(s)) {
    config.seats.forEach((seat, idx) => {
      const agentName = assignment[idx];
      expect(agentName).toBeDefined();
      const throwValue = policy[agentName as string];
      expect(throwValue).toBeDefined();
      s = g.submit(s, seat, { throw: throwValue as Throw }, "match.throw").state;
    });
    s = g.step(s);
  }
  return g.score(s);
}

describe("rps-n tournament and rating smoke", () => {
  test("rotation_lets_each_agent_play_each_seat_and_rating_table_orders_winner_first", () => {
    const matches = scheduleTournament(policyConfig, {
      agents: ["alwaysRock", "alwaysPaper"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"], // even multiple of 2 agents => balanced
      rotateSeatsAndRoles: true,
    });
    // Build a per-match seat->agent map and a rating instance per match's seating.
    let paperPoints = 0;
    let rockPoints = 0;
    for (const m of matches) {
      const assignment = m.assignments.map((row) => row.agentId);
      const seatToAgent = {} as Record<SeatId, string>;
      m.config.seats.forEach((seat, idx) => {
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
    const matches = scheduleTournament(policyConfig, {
      agents: ["alwaysRock", "alwaysPaper"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"],
      rotateSeatsAndRoles: true,
    });
    const seat0Agents = matches.map((m) => m.assignments[0]?.agentId);
    expect(new Set(seat0Agents).size).toBe(2); // both agents took seat 0 once
  });
});

import { describe, expect, test } from "bun:test";
import { scheduleTournament } from "../src/index";
import type { BudgetConfig } from "../src/index";

const budgets: BudgetConfig = {
  wallClockMsPerDecision: 5000,
  toolCallsPerTurn: 3,
  intelOrScoutPoints: 2,
  simRolloutsPerTurn: 4,
  invalidRetries: 1,
};

describe("rotating tournament", () => {
  test("schedules_one_match_per_seed", () => {
    const matches = scheduleTournament(budgets, {
      agents: ["a", "b", "c"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"],
      rotateSeatsAndRoles: true,
    });
    const [first] = matches;
    expect(matches).toHaveLength(2);
    expect(first?.matchId).toBe("rps-n:s0");
    expect(first?.seats).toHaveLength(3);
  });

  test("each_agent_occupies_each_seat_index_equally_over_full_rotation", () => {
    const agents = ["a", "b", "c"];
    const matches = scheduleTournament(budgets, {
      agents,
      gameId: "rps-n",
      seedBatch: ["s0", "s1", "s2"],
      rotateSeatsAndRoles: true,
    });
    const counts: Record<string, number[]> = {
      a: [0, 0, 0],
      b: [0, 0, 0],
      c: [0, 0, 0],
    };
    for (const m of matches) {
      const assignment = m.rules.seatAssignment as string[];
      assignment.forEach((agent, seatIdx) => {
        const row = counts[agent];
        if (row) row[seatIdx] = (row[seatIdx] ?? 0) + 1;
      });
    }
    for (const agent of agents) expect(counts[agent]).toEqual([1, 1, 1]);
  });

  test("identity_assignment_when_rotation_disabled", () => {
    const matches = scheduleTournament(budgets, {
      agents: ["a", "b"],
      gameId: "rps-n",
      seedBatch: ["s0", "s1"],
      rotateSeatsAndRoles: false,
    });
    for (const m of matches) expect(m.rules.seatAssignment).toEqual(["a", "b"]);
  });

  test("propagates_budgets_into_every_match_config", () => {
    const [match] = scheduleTournament(budgets, {
      agents: ["a", "b"],
      gameId: "rps-n",
      seedBatch: ["s0"],
      rotateSeatsAndRoles: true,
    });
    expect(match?.budgets).toEqual(budgets);
  });
});

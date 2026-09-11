import { describe, expect, test } from "bun:test";
import { runSpyTournament } from "./harness";

describe("spy tournament", () => {
  test("schedules_matches_and_returns_a_sorted_rating_table", () => {
    const agents = ["rand-A", "rand-B", "rand-C", "rand-D", "rand-E"];
    const seedBatch = ["t0", "t1", "t2", "t3"];
    const { table, matches } = runSpyTournament({ agents, seedBatch });
    expect(matches).toBeGreaterThanOrEqual(seedBatch.length);
    expect(table.length).toBe(agents.length);
    // table sorted by points desc.
    for (let i = 1; i < table.length; i++) {
      const prev = table[i - 1];
      const curr = table[i];
      if (prev === undefined || curr === undefined) throw new Error("table entry undefined");
      expect(prev.points).toBeGreaterThanOrEqual(curr.points);
    }
  });

  test("reports_win_rate_split_by_role_for_every_agent", () => {
    const agents = ["rand-A", "rand-B", "rand-C", "rand-D", "rand-E"];
    const { roleWinRate } = runSpyTournament({
      agents,
      seedBatch: ["s0", "s1", "s2", "s3", "s4", "s5"],
    });
    for (const a of agents) {
      const entry = roleWinRate[a];
      if (entry === undefined) throw new Error(`roleWinRate missing for agent ${a}`);
      expect(entry.asLoyal).toBeGreaterThanOrEqual(0);
      expect(entry.asLoyal).toBeLessThanOrEqual(1);
      expect(entry.asMole).toBeGreaterThanOrEqual(0);
      expect(entry.asMole).toBeLessThanOrEqual(1);
    }
  });

  test("baseline_win_rates_are_non_degenerate", () => {
    const agents = ["rand-A", "rand-B", "rand-C", "rand-D", "rand-E"];
    const seedBatch = Array.from({ length: 24 }, (_, i) => `b${i}`);
    const { alignmentTally } = runSpyTournament({ agents, seedBatch });
    const { loyalWins, loyalGames, moleWins, moleGames } = alignmentTally;
    // Both alignments must win at least one match and lose at least one match.
    // Fails if either alignment sweeps (0% or 100% win rate).
    expect(loyalGames).toBeGreaterThan(0);
    expect(moleGames).toBeGreaterThan(0);
    const loyalWinRate = loyalWins / loyalGames;
    const moleWinRate = moleWins / moleGames;
    expect(loyalWinRate).toBeGreaterThan(0);
    expect(loyalWinRate).toBeLessThan(1);
    expect(moleWinRate).toBeGreaterThan(0);
    expect(moleWinRate).toBeLessThan(1);
  });

  test("is_reproducible_with_same_inputs", () => {
    const agents = ["rand-A", "rand-B", "rand-C", "rand-D", "rand-E"];
    const seedBatch = ["r0", "r1", "r2", "r3", "r4"];
    const result1 = runSpyTournament({ agents, seedBatch });
    const result2 = runSpyTournament({ agents, seedBatch });
    expect(result1.matches).toBe(result2.matches);
    expect(result1.table.length).toBe(result2.table.length);
    for (let i = 0; i < result1.table.length; i++) {
      const r1 = result1.table[i];
      const r2 = result2.table[i];
      if (r1 === undefined || r2 === undefined) throw new Error("table entry undefined");
      expect(r1.agent).toBe(r2.agent);
      expect(r1.points).toBe(r2.points);
      expect(r1.winRate).toBe(r2.winRate);
    }
    for (const a of agents) {
      const wr1 = result1.roleWinRate[a];
      const wr2 = result2.roleWinRate[a];
      if (wr1 === undefined || wr2 === undefined) throw new Error(`roleWinRate missing for ${a}`);
      expect(wr1.asLoyal).toBe(wr2.asLoyal);
      expect(wr1.asMole).toBe(wr2.asMole);
    }
  });
});

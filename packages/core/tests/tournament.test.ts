import { describe, expect, test } from "bun:test";
import { scheduleTournament } from "../src/index";
import type { BudgetConfig, SeatId, TournamentPolicy } from "../src/index";

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

const policy = {
  identity: { protocolVersion: 2, runtimeVersion: "0.2.0", gameId: "rps-n", revision: "2.0.0" },
  timing: {
    playerTotalMs: 1000,
    decisionLimitMs: null,
    phaseLimits: {},
    clockVisibility: "private",
  },
  resources: { messages: { amount: 2, reset: "phase", visibility: "public" } },
  metering: { action: { resource: "messages", cost: 1 } },
} as const;
const args = {
  agents: ["a", "b"],
  gameId: "rps-n",
  seedBatch: ["s0", "s1"],
  rotateSeatsAndRoles: true,
  rules: { rounds: 3 },
};

describe("current tournament policies", () => {
  test("pins policies and rules independently in every scheduled match", () => {
    const matches = scheduleTournament(policy, args);
    expect(matches[0]?.config?.timing).toEqual(policy.timing);
    expect(matches[0]?.config?.resources).toEqual(policy.resources);
    expect(matches[0]?.config?.metering).toEqual(policy.metering);
    expect(matches[0]?.config?.identity).toEqual(policy.identity);
    expect(matches[0]?.config?.rules).toEqual({ rounds: 3 });
    expect(matches[0]?.seed).toBe("s0");
    expect(matches[0]?.seedIndex).toBe(0);
    expect(matches[0]?.assignments).toEqual([
      { seat: "seat:0" as SeatId, agentId: "a" },
      { seat: "seat:1" as SeatId, agentId: "b" },
    ]);
    expect(matches[1]?.assignments).toEqual([
      { seat: "seat:0" as SeatId, agentId: "b" },
      { seat: "seat:1" as SeatId, agentId: "a" },
    ]);
    expect(matches[0]?.config).not.toHaveProperty("budgets");
    const first = matches[0];
    if (!first) return;
    const messages = first.config.resources.messages;
    if (!messages) throw Error("missing scheduled resource");
    messages.amount = 0;
    expect(matches[1]?.config.resources.messages?.amount).toBe(2);
    expect(policy.resources.messages.amount).toBe(2);
  });
  test("rejects unsupported versions, mismatched games and malformed metering before scheduling", () => {
    for (const value of [
      { ...policy, identity: { ...policy.identity, gameId: "other" } },
      { ...policy, identity: { ...policy.identity, protocolVersion: 3 } },
      { ...policy, identity: { ...policy.identity, revision: 123 } },
      { ...policy, identity: { ...policy.identity, surprise: true } },
      { ...policy, identity: Object.create(policy.identity) },
      Object.create(policy),
      Object.defineProperty({ ...policy }, "extra", { value: true }),
      { ...policy, metering: { action: { resource: "unknown", cost: 1 } } },
    ])
      expect(() => scheduleTournament(value as unknown as TournamentPolicy, args)).toThrow();
  });
});

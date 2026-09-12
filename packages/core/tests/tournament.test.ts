import { describe, expect, test } from "bun:test";
import { scheduleTournament } from "../src/index";
import type { SeatId, TournamentPolicy } from "../src/index";

const policy = {
  identity: { protocolVersion: 1, runtimeVersion: "0.1.0", gameId: "rps-n", revision: "1.0.0" },
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

describe("tournament policies", () => {
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

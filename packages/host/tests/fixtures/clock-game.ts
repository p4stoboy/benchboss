import { type MatchConfig, type SeatId, mkSeatId } from "@benchboss/core";
import type { GamePlugin } from "@benchboss/referee";
import { createRegistry } from "../../src/registry";

interface State {
  round: number;
  rounds: number;
  seats: SeatId[];
  acted: SeatId[];
}

export function clockGame(rounds = 1) {
  const calls: string[] = [];
  const budgets = {
    wallClockMsPerDecision: 1000,
    toolCallsPerTurn: 10,
    intelOrScoutPoints: 10,
    simRolloutsPerTurn: 0,
    invalidRetries: 2,
  };
  const over = (s: State) => s.round >= s.rounds;
  const plugin: GamePlugin<State> = {
    id: "clock-game",
    manifest: {
      protocolVersion: 1,
      id: "clock-game",
      revision: "1",
      title: "Clock game",
      description: "Independent lifecycle fixture",
      rulesSource: "Choose or inspect",
      seatCounts: [2],
      defaultSeats: 2,
      rulesSchema: { type: "object" },
      defaultRules: {},
      defaultBudgets: budgets,
      roundStructure: [],
      winConditions: [],
      safeDefaults: [],
      disclosure: "full-after-terminal",
    },
    makeGame: () => ({
      id: "clock-game",
      newMatch: (config: MatchConfig) => ({ round: 0, rounds, seats: config.seats, acted: [] }),
      observe: (s, seat) => ({
        matchId: "m",
        phase: "choose",
        seat,
        publicState: {},
        privateState: {},
      }),
      legalActions: (s, seat) =>
        over(s) || s.acted.includes(seat)
          ? []
          : ["choose", "inspect"].map((tool) => ({
              tool,
              phase: "choose",
              jsonSchema: { type: "object", additionalProperties: false },
            })),
      submit: (s, seat) => {
        calls.push(`${s.round}:${seat}`);
        return { accepted: true, reason: "ok", state: { ...s, acted: [...s.acted, seat] } };
      },
      step: (s) => ({ ...s, round: s.round + 1, acted: [] }),
      isTerminal: over,
      score: (s) => Object.fromEntries(s.seats.map((seat) => [seat, 0])),
    }),
    publicView: (s) => ({
      version: 1,
      progress: {
        phase: over(s) ? "over" : "choose",
        label: "Choose",
        current: s.round,
        total: s.rounds,
      },
      blocks: [],
      result: over(s)
        ? {
            summary: "Draw",
            seats: s.seats.map((seat) => ({ seat, placement: 1, outcome: "draw", metrics: [] })),
          }
        : null,
    }),
    phaseToTools: { choose: ["choose", "inspect"] },
    currentPhase: () => "choose",
    isReady: (s) => s.acted.length === s.seats.length,
    safeDefault: () => ({ tool: "choose", input: {} }),
    senseResolvers: () => [
      {
        tool: "inspect",
        budgetKey: "intelOrScoutPoints",
        cost: () => 1,
        resolve: (s) => ({ result: { inspected: true }, nextState: s }),
      },
    ],
    defaultSeats: 2,
    defaultBudgets: budgets,
  };
  const registry = createRegistry([plugin]);
  const seats = [mkSeatId(0), mkSeatId(1)];
  const config = registry.buildConfig("m", plugin.id, seats);
  if (config.budgets === undefined) throw Error("expected legacy config");
  const spec = {
    matchId: "m",
    gameId: plugin.id,
    seed: "secret",
    config,
    assignments: seats.map((seat, i) => ({ seat, agentId: `a${i}`, principalId: `p${i}` })),
  };
  return { plugin, registry, spec, calls };
}

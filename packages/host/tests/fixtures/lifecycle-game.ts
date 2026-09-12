import { type MatchConfig, type SeatId, mkSeatId } from "@benchboss/core";
import type { GamePlugin } from "@benchboss/referee";
import { createRegistry } from "../../src/registry";

interface State {
  seats: SeatId[];
  active: number;
  finished: SeatId[];
  done: boolean;
  moves: number;
}
export function lifecycleGame() {
  const plugin = {
    id: "lifecycle",
    manifest: {
      protocolVersion: 1,
      id: "lifecycle",
      revision: "1.0.0",
      title: "Lifecycle",
      description: "Host timing fixture",
      rulesSource: "Pass or finish",
      seatCounts: [2],
      defaultSeats: 2,
      rulesSchema: { type: "object", additionalProperties: false },
      defaultRules: {},
      defaultTiming: {
        playerTotalMs: 1000,
        decisionLimitMs: null,
        phaseLimits: {},
        clockVisibility: "public",
      },
      defaultResources: {
        actions: { amount: 100, reset: "match", visibility: "public" },
        secrets: { amount: 7, reset: "match", visibility: "private" },
      },
      defaultMetering: { action: { resource: "actions", cost: 1 } },
      roundStructure: [],
      winConditions: [],
      safeDefaults: [],
      disclosure: "full-after-terminal",
    },
    defaultSeats: 2,
    makeGame: () => ({
      id: "lifecycle",
      newMatch: (config: MatchConfig) => ({
        seats: config.seats,
        active: 0,
        finished: [],
        done: false,
        moves: 0,
      }),
      observe: (_state, seat) => ({
        matchId: "m",
        phase: "choose",
        seat,
        publicState: {},
        privateState: { hidden: true },
      }),
      legalActions: (s, seat) =>
        s.done || s.finished.includes(seat) || s.seats[s.active] !== seat
          ? []
          : ["pass", "finish"].map((tool) => ({
              tool,
              phase: "choose",
              description: tool,
              jsonSchema: { type: "object", additionalProperties: false },
            })),
      submit: (s, seat, _input, tool) => {
        const finished = tool === "finish" ? [...s.finished, seat] : s.finished;
        return {
          accepted: true,
          reason: "ok",
          state: {
            ...s,
            finished,
            active: (s.active + 1) % 2,
            moves: s.moves + 1,
            done: finished.length === 2,
          },
        };
      },
      step: (s) => s,
      isTerminal: (s) => s.done,
      score: (s) => Object.fromEntries(s.seats.map((seat) => [seat, 0])),
    }),
    publicView: (s) => ({
      version: 1,
      progress: { phase: "choose", label: "Choose", current: s.moves, total: null },
      blocks: [],
      result: s.done
        ? {
            summary: "Finished",
            cause: { kind: "time" },
            seats: s.seats.map((seat) => ({ seat, placement: 1, outcome: "draw", metrics: [] })),
          }
        : null,
    }),
    phaseToTools: { choose: ["pass", "finish"] },
    currentPhase: () => "choose",
    isReady: () => false,
    safeDefault: () => ({ tool: "finish", input: {} }),
    participation: (s, seat) =>
      s.finished.includes(seat)
        ? { status: "finished", reason: "retired" }
        : s.seats[s.active] === seat
          ? { status: "acting" }
          : { status: "waiting" },
    onHostEvent: (s, event) => ({
      ...s,
      done: true,
      finished: [...new Set([...s.finished, ...event.seats])] as SeatId[],
    }),
  } satisfies GamePlugin<State>;
  const registry = createRegistry([plugin]);
  const seats = [mkSeatId(0), mkSeatId(1)];
  const config = registry.buildConfig("m", plugin.id, seats);
  return {
    plugin,
    registry,
    spec: {
      matchId: "m",
      gameId: plugin.id,
      seed: "seed",
      config,
      assignments: seats.map((seat, i) => ({ seat, agentId: `a${i}`, principalId: `p${i}` })),
    },
  };
}

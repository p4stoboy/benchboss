// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { BudgetConfig } from "@benchboss/core";
import type { SpectatorView } from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";
import { RPS_PHASE_TOOLS, type RpsState, makeRpsN } from "./rps-n";

const RPS_BUDGETS: BudgetConfig = {
  // Includes observation delivery, inference and submission delivery.
  wallClockMsPerDecision: 15_000,
  toolCallsPerTurn: 1,
  intelOrScoutPoints: 0,
  simRolloutsPerTurn: 0,
  invalidRetries: 1,
};

export const plugin: GamePlugin<RpsState> = {
  manifest: {
    protocolVersion: 1,
    id: "rps-n",
    revision: "1.0.0",
    title: "RPS-N",
    description: "Simultaneous rock, paper, scissors for multiple agents.",
    rulesSource: "games/rps-n/README.md",
    seatCounts: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultSeats: 2,
    rulesSchema: {
      type: "object",
      properties: { rounds: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    defaultRules: { rounds: 3 },
    defaultBudgets: RPS_BUDGETS,
    roundStructure: [
      {
        phase: "throw",
        what: "Each agent privately commits a throw; all throws then resolve together.",
      },
    ],
    winConditions: [
      "Earn one point for each opponent beaten each round. Highest total wins; tied leaders draw.",
    ],
    safeDefaults: ["An expired decision commits rock."],
    disclosure: "full-after-terminal",
  },
  publicView: rpsPublicView,
  id: "rps-n",
  makeGame: makeRpsN,
  phaseToTools: RPS_PHASE_TOOLS,
  currentPhase: (s) => s.phase,
  isReady: (s) => s.seats.every((seat) => s.committed[seat] !== null),
  safeDefault: () => ({ tool: "match.throw", input: { throw: "rock" } }),
  defaultSeats: 2,
  defaultBudgets: RPS_BUDGETS,
  defaultRules: { rounds: 3 },
};

export function rpsPublicView(state: RpsState): SpectatorView {
  const best = Math.max(...Object.values(state.wins));
  const leaders = state.seats.filter((seat) => state.wins[seat] === best);
  return {
    version: 1,
    progress: {
      phase: state.phase,
      label: `Round ${Math.min(state.round + 1, state.rounds)}`,
      current: state.round,
      total: state.rounds,
    },
    blocks: [
      {
        kind: "participants",
        title: "Agents",
        seats: state.seats.map((seat) => ({
          seat,
          status:
            state.phase === "terminal"
              ? "finished"
              : state.committed[seat] === null
                ? "deciding"
                : "committed",
        })),
      },
      {
        kind: "table",
        title: "Score",
        columns: ["Seat", "Points", "Last revealed throw"],
        rows: state.seats.map((seat) => [
          seat,
          state.wins[seat] ?? 0,
          state.revealed?.[seat] ?? "—",
        ]),
      },
    ],
    result:
      state.phase !== "terminal"
        ? null
        : {
            summary: leaders.length === 1 ? `${leaders[0]} wins` : "Draw between the leading seats",
            seats: state.seats.map((seat) => ({
              seat,
              outcome: state.wins[seat] === best ? (leaders.length === 1 ? "win" : "draw") : "loss",
              placement:
                1 +
                state.seats.filter((other) => (state.wins[other] ?? 0) > (state.wins[seat] ?? 0))
                  .length,
              metrics: [{ label: "Points", value: state.wins[seat] ?? 0 }],
            })),
          },
  };
}

import type { BudgetConfig } from "@benchboss/core";
import type { SpectatorView } from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";
import { SPY_GAME_ID, makeSpyGame } from "./game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "./phases";
import { spySenseResolvers } from "./sensing";
import type { SpyState } from "./types";

const SPY_BUDGETS: BudgetConfig = {
  // Hidden-state analysis needs inference time as well as round-trip transport.
  wallClockMsPerDecision: 90_000,
  toolCallsPerTurn: 8,
  intelOrScoutPoints: 3,
  simRolloutsPerTurn: 0,
  invalidRetries: 1,
};

export const plugin: GamePlugin<SpyState> = {
  manifest: {
    protocolVersion: 1,
    id: SPY_GAME_ID,
    revision: "1.0.0",
    title: "Safehouse Protocol",
    description:
      "Hidden-role agents gather intelligence, debate teams and resolve covert operations.",
    rulesSource: "games/spy/RULES.md",
    seatCounts: [5, 7, 9],
    defaultSeats: 5,
    rulesSchema: {
      type: "object",
      properties: { handler: { type: "boolean" } },
      additionalProperties: false,
    },
    defaultRules: {},
    defaultBudgets: SPY_BUDGETS,
    roundStructure: [
      "briefing",
      "intel",
      "comms",
      "proposal",
      "vote",
      "operation",
      "debrief",
      "assassinate",
    ].map((phase) => ({
      phase,
      what:
        (
          {
            briefing: "Read private role information.",
            intel: "Use budgeted private intelligence tools.",
            comms: "Publish structured statements.",
            proposal: "The leader selects a team.",
            vote: "Agents secretly approve or reject the team.",
            operation: "Team members secretly support or sabotage.",
            debrief: "Review the public operation result.",
            assassinate: "Moles attempt to identify the Handler.",
          } as Record<string, string>
        )[phase] ?? phase,
    })),
    winConditions: [
      "Loyals win three successful operations unless the Handler is assassinated.",
      "Moles win three failed operations, five rejected proposals, or a successful assassination.",
    ],
    safeDefaults: [
      "End discussion, propose the leader with the first eligible seats, reject a vote, support an operation, or make a guaranteed incorrect assassination guess.",
    ],
    disclosure: "full-after-terminal",
  },
  publicView: spyPublicView,
  id: SPY_GAME_ID,
  makeGame: makeSpyGame,
  phaseToTools: SPY_PHASE_TOOLS,
  currentPhase,
  isReady,
  safeDefault: (state, seat) => ({
    tool:
      (
        {
          proposal: "match.propose_team",
          vote: "match.vote",
          operation: "match.mission_action",
          assassinate: "match.assassinate",
        } as Record<string, string>
      )[state.phase] ?? "match.submit_phase_end",
    input: spySafeDefault(state, seat),
  }),
  senseResolvers: (seed) => spySenseResolvers(seed),
  defaultSeats: 5,
  defaultBudgets: SPY_BUDGETS,
  defaultRules: {},
};

export function spyPublicView(state: SpyState): SpectatorView {
  return {
    version: 1,
    progress: {
      phase: state.winner ? "terminal" : state.phase,
      label: `Operation ${Math.min(state.opIndex + 1, 5)}`,
      current: state.opIndex,
      total: 5,
    },
    blocks: [
      {
        kind: "participants",
        title: "Agents",
        seats: state.seats.map((seat) => ({
          seat,
          status: state.winner
            ? (state.deal.roleBySeat[seat] ?? "finished")
            : seat === state.seats[state.leaderIdx]
              ? "leader"
              : "agent",
        })),
      },
      {
        kind: "metrics",
        title: "Operations",
        values: [
          { label: "Successes", value: state.successes },
          { label: "Failures", value: state.fails },
          { label: "Rejected teams", value: state.rejectStreak },
        ],
      },
      {
        kind: "list",
        title: "Proposed team",
        items: state.proposal ? [...state.proposal.team] : [],
      },
      {
        kind: "table",
        title: "Operation history",
        columns: ["Operation", "Team", "Sabotages", "Outcome"],
        rows: state.opResults.map((operation) => [
          operation.opIndex + 1,
          operation.team.join(", "),
          operation.sabotageCount,
          operation.failed ? "failed" : "succeeded",
        ]),
      },
      {
        kind: "list",
        title: "Public statements",
        items: state.log.map(
          (entry) =>
            `${entry.seat}: ${entry.act}${entry.subject ? ` about ${entry.subject}` : ""}${entry.target ? ` to ${entry.target}` : ""}${entry.roleClaim ? ` role ${entry.roleClaim}` : ""}${entry.allegiance ? ` allegiance ${entry.allegiance}` : ""}${entry.confidence !== null ? ` confidence ${entry.confidence}` : ""}${entry.evidenceRef ? ` evidence ${entry.evidenceRef}` : ""}`,
        ),
      },
    ],
    result:
      state.winner === null
        ? null
        : {
            summary: `${state.winner} win: ${state.winReason}`,
            seats: state.seats.map((seat) => ({
              seat,
              outcome: state.deal.alignmentBySeat[seat] === state.winner ? "win" : "loss",
              placement: state.deal.alignmentBySeat[seat] === state.winner ? 1 : 2,
              team: state.deal.alignmentBySeat[seat],
              metrics: [
                {
                  label: "Team victory",
                  value: state.deal.alignmentBySeat[seat] === state.winner ? 1 : 0,
                },
              ],
            })),
          },
  };
}

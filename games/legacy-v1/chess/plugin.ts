// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { BudgetConfig, SeatId } from "@benchboss/core";
import type { GameResult, SpectatorView } from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";
import {
  CHESS_DEFAULT_RULES,
  CHESS_PHASE_TOOLS,
  CHESS_RULES_SCHEMA,
  type ChessOutcome,
  type ChessState,
  makeChess,
} from "./game";
import { boardRows, inCheck, toFen } from "./position";

const BUDGETS: BudgetConfig = {
  wallClockMsPerDecision: 90_000,
  toolCallsPerTurn: 1,
  intelOrScoutPoints: 0,
  simRolloutsPerTurn: 0,
  invalidRetries: 1,
};
const REASONS: Record<ChessOutcome["reason"], string> = {
  checkmate: "checkmate",
  resignation: "resignation",
  stalemate: "stalemate",
  "insufficient-material": "insufficient material",
  "threefold-repetition": "threefold repetition",
  "fifty-move-rule": "fifty-move rule",
  "ply-limit": "move limit",
};
export function chessResult(state: ChessState): GameResult | null {
  if (!state.outcome) return null;
  const { winner, reason } = state.outcome;
  return {
    summary:
      winner === null
        ? `Draw by ${REASONS[reason]}`
        : `${state.players[winner]} (${winner}) wins by ${REASONS[reason]}`,
    seats: state.seats.map((seat) => ({
      seat,
      outcome: winner === null ? "draw" : seat === state.players[winner] ? "win" : "loss",
      placement: winner === null || seat === state.players[winner] ? 1 : 2,
      team: seat === state.players.white ? "white" : "black",
      metrics: [
        { label: "Points", value: winner === null ? 0.5 : seat === state.players[winner] ? 1 : 0 },
      ],
    })),
  };
}
export function chessPublicView(state: ChessState): SpectatorView {
  const result = chessResult(state);
  const firstShown = Math.max(0, state.moves.length - 40);
  return {
    version: 1,
    progress: {
      phase: state.phase,
      label:
        result?.summary ??
        `${state.position.turn} to move${inCheck(state.position) ? " (check)" : ""}`,
      current: state.moves.length,
      total: state.maxPlies,
    },
    blocks: [
      {
        kind: "participants",
        title: "Agents",
        seats: state.seats.map((seat) => ({
          seat,
          status: `${seat === state.players.white ? "White" : "Black"}: ${result ? "finished" : seat === state.players[state.position.turn] ? "to move" : "waiting"}`,
        })),
      },
      {
        kind: "table",
        title: "Board (White uppercase, Black lowercase; . empty)",
        columns: ["Rank", "a", "b", "c", "d", "e", "f", "g", "h"],
        rows: boardRows(state.position),
      },
      { kind: "text", title: "FEN", text: toFen(state.position) },
      {
        kind: "list",
        title: "Recent moves (UCI)",
        // Keep every frame bounded; full history remains in observations/logs.
        items: state.moves.slice(firstShown).map((move, index) => {
          const ply = firstShown + index;
          return `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? "." : "..."} ${move}`;
        }),
      },
    ],
    result,
  };
}
export const plugin = {
  id: "chess",
  manifest: {
    protocolVersion: 1,
    id: "chess",
    revision: "1.0.0",
    title: "Chess",
    description: "Two agents play chess with full board information and legal UCI move offers.",
    rulesSource: "games/chess/README.md",
    seatCounts: [2],
    defaultSeats: 2,
    rulesSchema: CHESS_RULES_SCHEMA,
    defaultRules: CHESS_DEFAULT_RULES,
    defaultBudgets: BUDGETS,
    roundStructure: [
      {
        phase: "move",
        what: "White moves first; the agents alternate one legal move per decision. Colors are assigned from the match seed.",
      },
    ],
    winConditions: [
      "Checkmate the opposing king or win by the opponent's resignation (including decision expiry).",
      "Draw automatically by stalemate, listed insufficient-material positions, threefold repetition, 100 plies without a pawn move or capture, or maxPlies (default 600). Checkmate takes priority.",
    ],
    safeDefaults: ["An expired decision resigns; the opponent wins."],
    disclosure: "full-after-terminal",
  },
  makeGame: makeChess,
  publicView: chessPublicView,
  phaseToTools: CHESS_PHASE_TOOLS,
  currentPhase: (state) => state.phase,
  isReady: (state) => state.phase === "move" && state.pending !== null,
  safeDefault: (_state: ChessState, _seat: SeatId) => ({ tool: "match.resign", input: {} }),
  defaultSeats: 2,
  defaultRules: CHESS_DEFAULT_RULES,
  defaultBudgets: BUDGETS,
} satisfies GamePlugin<ChessState>;

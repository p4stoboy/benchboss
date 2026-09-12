import {
  type GameModule,
  type LegalActionSpec,
  type MatchConfig,
  type SeatId,
  createRng,
} from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import {
  type Color,
  type Position,
  boardRows,
  inCheck,
  initialPosition,
  insufficientMaterial,
  legalMoves,
  opposite,
  playMove,
  repetitionKey,
  toFen,
} from "./position";

export interface ChessOutcome {
  cause?:
    | "decision_expired"
    | "player_time_exhausted"
    | "phase_expired"
    | "invalid_retries_exhausted";
  winner: Color | null;
  reason:
    | "checkmate"
    | "resignation"
    | "timeout"
    | "invalid-actions"
    | "stalemate"
    | "insufficient-material"
    | "threefold-repetition"
    | "fifty-move-rule"
    | "ply-limit";
}
type PendingAction = { tool: "match.move"; move: string } | { tool: "match.resign" };
export interface ChessState {
  matchId: string;
  phase: "move" | "terminal";
  seats: SeatId[];
  players: Record<Color, SeatId>;
  position: Position;
  moves: string[];
  maxPlies: number;
  repetitions: Record<string, number>;
  pending: PendingAction | null;
  outcome: ChessOutcome | null;
}
export interface ChessPublicState {
  players: Record<Color, SeatId>;
  turn: Color;
  fen: string;
  board: string[][];
  inCheck: boolean;
  legalMoves: string[];
  moves: string[];
  ply: number;
  maxPlies: number;
  outcome: ChessOutcome | null;
}
export interface ChessObservation {
  matchId: string;
  phase: string;
  seat: SeatId;
  publicState: ChessPublicState;
  privateState: Record<string, never>;
  legalTools: string[];
}
export const CHESS_DEFAULT_RULES = { maxPlies: 600 };
export const CHESS_RULES_SCHEMA = {
  type: "object",
  properties: { maxPlies: { type: "integer", minimum: 1, maximum: 1000 } },
  additionalProperties: false,
};
export const CHESS_PHASE_TOOLS = {
  move: ["match.move", "match.resign"],
  terminal: [],
} satisfies Record<string, string[]>;
const canAct = (state: ChessState, seat: SeatId): boolean =>
  state.phase === "move" && state.pending === null && state.players[state.position.turn] === seat;

export function chessPublicState(state: ChessState): ChessPublicState {
  return {
    players: { ...state.players },
    turn: state.position.turn,
    fen: toFen(state.position),
    board: boardRows(state.position),
    inCheck: inCheck(state.position),
    legalMoves: state.phase === "terminal" ? [] : legalMoves(state.position),
    moves: [...state.moves],
    ply: state.moves.length,
    maxPlies: state.maxPlies,
    outcome: state.outcome ? { ...state.outcome } : null,
  };
}

function offers(state: ChessState, seat: SeatId): LegalActionSpec[] {
  if (!canAct(state, seat)) return [];
  return [
    {
      tool: "match.move",
      phase: "move",
      description:
        "Play a legal UCI move, e.g. e2e4 or e7e8q. Castling uses the king destination (e1g1). Promotion requires q/r/b/n. Only the side to move may act.",
      jsonSchema: {
        type: "object",
        properties: { move: { type: "string", enum: legalMoves(state.position) } },
        required: ["move"],
        additionalProperties: false,
      },
    },
    {
      tool: "match.resign",
      phase: "move",
      description: "Resign this game and award the opponent a win.",
      jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

function adjudicate(
  position: Position,
  repetitions: number,
  ply: number,
  maxPlies: number,
): ChessOutcome | null {
  if (legalMoves(position).length === 0)
    return inCheck(position)
      ? { winner: opposite(position.turn), reason: "checkmate" }
      : { winner: null, reason: "stalemate" };
  if (insufficientMaterial(position)) return { winner: null, reason: "insufficient-material" };
  if (repetitions >= 3) return { winner: null, reason: "threefold-repetition" };
  if (position.halfmove >= 100) return { winner: null, reason: "fifty-move-rule" };
  if (ply >= maxPlies) return { winner: null, reason: "ply-limit" };
  return null;
}

export function makeChess(): GameModule<ChessState, unknown, ChessObservation, number> {
  return {
    id: "chess",
    newMatch(config: MatchConfig, seed: string): ChessState {
      if (
        config.gameId !== "chess" ||
        config.seats.length !== 2 ||
        config.seats[0] === config.seats[1] ||
        config.seats.some(
          (seat) => typeof seat !== "string" || !/^seat:(0|[1-9][0-9]*)$/.test(seat),
        )
      )
        throw Error("Chess requires two distinct seats");
      if (!validateSchema(CHESS_RULES_SCHEMA, config.rules).ok) throw Error("Invalid chess rules");
      const [white, black] = createRng(seed)
        .fork("chess-colors")
        .shuffle([...config.seats]);
      if (!white || !black) throw Error("Missing chess seats");
      const position = initialPosition();
      return {
        matchId: config.matchId,
        phase: "move",
        seats: [...config.seats],
        players: { white, black },
        position,
        moves: [],
        maxPlies: (config.rules.maxPlies as number | undefined) ?? CHESS_DEFAULT_RULES.maxPlies,
        repetitions: { [repetitionKey(position)]: 1 },
        pending: null,
        outcome: null,
      };
    },
    observe(state, seat) {
      return {
        matchId: state.matchId,
        phase: state.phase,
        seat,
        publicState: chessPublicState(state),
        privateState: {},
        legalTools: canAct(state, seat) ? [...CHESS_PHASE_TOOLS.move] : [],
      };
    },
    legalActions: offers,
    submit(state, seat, input, tool) {
      const rejected = (reason: string) => ({ accepted: false, reason, state });
      if (!canAct(state, seat)) return rejected("Seat cannot act in this position");
      if (!input || typeof input !== "object" || Array.isArray(input))
        return rejected("Expected an action object");
      const keys = Object.keys(input);
      let pending: PendingAction;
      if (tool === "match.resign") {
        if (keys.length !== 0) return rejected("Resignation takes no fields");
        pending = { tool };
      } else if (tool === "match.move") {
        if (
          keys.length !== 1 ||
          keys[0] !== "move" ||
          !("move" in input) ||
          typeof input.move !== "string"
        )
          return rejected("Expected exactly one UCI move");
        if (!playMove(state.position, input.move)) return rejected("Illegal chess move");
        pending = { tool, move: input.move };
      } else return rejected("Unknown or missing chess tool");
      return {
        accepted: true,
        reason: "ok",
        committedActionId: `${state.matchId}:ply${state.moves.length}:${seat}`,
        state: { ...state, pending },
      };
    },
    step(state) {
      if (state.phase === "terminal" || !state.pending) return state;
      if (state.pending.tool === "match.resign")
        return {
          ...state,
          phase: "terminal",
          pending: null,
          outcome: { winner: opposite(state.position.turn), reason: "resignation" },
        };
      const position = playMove(state.position, state.pending.move);
      if (!position) throw Error("Invalid committed chess move");
      const moves = [...state.moves, state.pending.move];
      const key = repetitionKey(position);
      const occurrences = (state.repetitions[key] ?? 0) + 1;
      const repetitions = { ...state.repetitions, [key]: occurrences };
      const outcome = adjudicate(position, occurrences, moves.length, state.maxPlies);
      return {
        ...state,
        position,
        moves,
        repetitions,
        pending: null,
        outcome,
        phase: outcome ? "terminal" : "move",
      };
    },
    isTerminal: (state) => state.phase === "terminal",
    score: (state) =>
      Object.fromEntries(
        state.seats.map((seat) => [
          seat,
          !state.outcome
            ? 0
            : state.outcome.winner === null
              ? 0.5
              : seat === state.players[state.outcome.winner]
                ? 1
                : 0,
        ]),
      ),
  };
}

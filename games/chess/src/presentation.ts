import type { ChessState } from "./game";
import { inCheck } from "./position";

/** a1..h1, a2..h2, ... a8..h8; uppercase White, lowercase Black, null empty. */
export interface ChessCanvasState {
  board: (string | null)[];
  turn: "white" | "black";
  lastMove: string | null;
  checkedKing: number | null;
}

export function chessCanvasState(state: ChessState): ChessCanvasState {
  const checked = inCheck(state.position);
  return {
    board: [...state.position.board],
    turn: state.position.turn,
    lastMove: state.moves.at(-1) ?? null,
    checkedKing: checked
      ? state.position.board.indexOf(state.position.turn === "white" ? "K" : "k")
      : null,
  };
}

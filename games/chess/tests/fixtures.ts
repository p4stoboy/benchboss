import type { Piece, Position } from "../src/position";

// Test-only FEN fixtures: production matches always use the standard initial board.
export function position(fen: string): Position {
  const [placement, side, castling, ep, halfmove, fullmove] = fen.split(" ");
  if (!placement || !side || !castling || !ep) throw Error("Invalid fixture");
  const board: (Piece | null)[] = Array.from({ length: 64 }, () => null);
  for (const [rank, row] of placement.split("/").entries()) {
    let file = 0;
    for (const char of row) {
      if (/^[1-8]$/.test(char)) file += Number(char);
      else board[(7 - rank) * 8 + file++] = char as Piece;
    }
    if (file !== 8) throw Error("Invalid fixture rank");
  }
  return {
    board,
    turn: side === "w" ? "white" : "black",
    castling: castling === "-" ? "" : castling,
    enPassant: ep === "-" ? null : (Number(ep[1]) - 1) * 8 + ep.charCodeAt(0) - 97,
    halfmove: Number(halfmove ?? 0),
    fullmove: Number(fullmove ?? 1),
  };
}

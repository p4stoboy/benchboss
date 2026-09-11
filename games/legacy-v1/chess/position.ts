// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
export type Color = "white" | "black";
export type Piece = "P" | "N" | "B" | "R" | "Q" | "K" | "p" | "n" | "b" | "r" | "q" | "k";
export interface Position {
  // a1 = 0, h1 = 7, a8 = 56. Uppercase pieces are White.
  board: readonly (Piece | null)[];
  turn: Color;
  castling: string;
  enPassant: number | null;
  halfmove: number;
  fullmove: number;
}
interface Move {
  from: number;
  to: number;
  promotion?: "q" | "r" | "b" | "n";
}
const ORTHOGONAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIAGONAL = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
const KING = [...ORTHOGONAL, ...DIAGONAL];
const KNIGHT = [
  [1, 2],
  [2, 1],
  [-1, 2],
  [-2, 1],
  [1, -2],
  [2, -1],
  [-1, -2],
  [-2, -1],
] as const;
const PROMOTIONS = ["q", "r", "b", "n"] as const;

export const opposite = (color: Color): Color => (color === "white" ? "black" : "white");
export const pieceColor = (piece: Piece): Color =>
  piece === piece.toUpperCase() ? "white" : "black";
export const squareName = (square: number): string =>
  `${"abcdefgh"[square % 8]}${Math.floor(square / 8) + 1}`;
const uci = (move: Move): string =>
  `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
const at = (file: number, rank: number): number | null =>
  file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : null;

export function initialPosition(): Position {
  const back: Piece[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  return {
    board: [
      ...back,
      ...Array.from({ length: 8 }, (): Piece => "P"),
      ...Array.from({ length: 32 }, () => null),
      ...Array.from({ length: 8 }, (): Piece => "p"),
      ...back.map((piece) => piece.toLowerCase() as Piece),
    ],
    turn: "white",
    castling: "KQkq",
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
  };
}

// Attack geometry deliberately includes pinned attackers (king/castling safety).
export function isAttacked(position: Position, target: number, by: Color): boolean {
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || pieceColor(piece) !== by) continue;
    const df = (target % 8) - (from % 8);
    const dr = Math.floor(target / 8) - Math.floor(from / 8);
    const kind = piece.toLowerCase();
    if (kind === "p") {
      if (Math.abs(df) === 1 && dr === (by === "white" ? 1 : -1)) return true;
      continue;
    }
    if (kind === "n") {
      if (Math.abs(df) * Math.abs(dr) === 2) return true;
      continue;
    }
    if (kind === "k") {
      if (Math.max(Math.abs(df), Math.abs(dr)) === 1) return true;
      continue;
    }
    if (df === 0 && dr === 0) continue;
    const diagonal = Math.abs(df) === Math.abs(dr);
    const straight = df === 0 || dr === 0;
    if (!(kind === "q" ? diagonal || straight : kind === "b" ? diagonal : straight)) continue;
    const stride = Math.sign(df) + Math.sign(dr) * 8;
    let square = from + stride;
    while (square !== target && !position.board[square]) square += stride;
    if (square === target) return true;
  }
  return false;
}

export function inCheck(position: Position, color = position.turn): boolean {
  const king = position.board.indexOf(color === "white" ? "K" : "k");
  return king < 0 || isAttacked(position, king, opposite(color));
}

function apply(position: Position, move: Move): Position {
  const piece = position.board[move.from];
  if (!piece) throw Error("Move has no source piece");
  const board = [...position.board];
  const pawn = piece.toLowerCase() === "p";
  const king = piece.toLowerCase() === "k";
  const ep =
    pawn && move.to === position.enPassant && !board[move.to] && move.from % 8 !== move.to % 8;
  const capture = Boolean(board[move.to]) || ep;
  board[move.from] = null;
  board[move.to] = move.promotion
    ? ((position.turn === "white" ? move.promotion.toUpperCase() : move.promotion) as Piece)
    : piece;
  if (ep) board[move.to + (position.turn === "white" ? -8 : 8)] = null;
  if (king && Math.abs(move.to - move.from) === 2) {
    const rookFrom = move.to > move.from ? move.from + 3 : move.from - 4;
    const rookTo = move.to > move.from ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom] ?? null;
    board[rookFrom] = null;
  }
  let castling = position.castling;
  if (king) castling = castling.replace(position.turn === "white" ? /[KQ]/g : /[kq]/g, "");
  for (const [square, right] of [
    [0, "Q"],
    [7, "K"],
    [56, "q"],
    [63, "k"],
  ] as const) {
    if (move.from === square || move.to === square) castling = castling.replace(right, "");
  }
  return {
    board,
    turn: opposite(position.turn),
    castling,
    enPassant: pawn && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : null,
    halfmove: pawn || capture ? 0 : position.halfmove + 1,
    fullmove: position.fullmove + (position.turn === "black" ? 1 : 0),
  };
}

function candidates(position: Position): Move[] {
  const moves: Move[] = [];
  const addPawn = (from: number, to: number) => {
    if (Math.floor(to / 8) === (position.turn === "white" ? 7 : 0)) {
      for (const promotion of PROMOTIONS) moves.push({ from, to, promotion });
    } else moves.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || pieceColor(piece) !== position.turn) continue;
    const kind = piece.toLowerCase();
    const file = from % 8;
    const rank = Math.floor(from / 8);
    if (kind === "p") {
      const dr = position.turn === "white" ? 1 : -1;
      const one = at(file, rank + dr);
      if (one !== null && !position.board[one]) {
        addPawn(from, one);
        const two = at(file, rank + dr * 2);
        if (rank === (position.turn === "white" ? 1 : 6) && two !== null && !position.board[two])
          moves.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const to = at(file + df, rank + dr);
        if (to === null) continue;
        const target = position.board[to];
        const capture =
          target && pieceColor(target) !== position.turn && target.toLowerCase() !== "k";
        const ep =
          !target &&
          to === position.enPassant &&
          position.board[to - dr * 8] === (position.turn === "white" ? "p" : "P");
        if (capture || ep) addPawn(from, to);
      }
      continue;
    }
    const directions =
      kind === "n" ? KNIGHT : kind === "b" ? DIAGONAL : kind === "r" ? ORTHOGONAL : KING;
    for (const [df, dr] of directions) {
      for (let distance = 1; distance < 8; distance++) {
        const to = at(file + df * distance, rank + dr * distance);
        if (to === null) break;
        const target = position.board[to];
        if (target && (pieceColor(target) === position.turn || target.toLowerCase() === "k")) break;
        moves.push({ from, to });
        if (target || kind === "n" || kind === "k") break;
      }
    }
    if (kind !== "k" || from !== (position.turn === "white" ? 4 : 60) || inCheck(position))
      continue;
    for (const kingside of [true, false]) {
      const right = position.turn === "white" ? (kingside ? "K" : "Q") : kingside ? "k" : "q";
      if (!position.castling.includes(right)) continue;
      const rook = from + (kingside ? 3 : -4);
      if (position.board[rook] !== (position.turn === "white" ? "R" : "r")) continue;
      const empty = kingside ? [1, 2] : [-1, -2, -3];
      if (empty.some((offset) => position.board[from + offset])) continue;
      const transit = from + (kingside ? 1 : -1);
      if (inCheck(apply(position, { from, to: transit }), position.turn)) continue;
      moves.push({ from, to: from + (kingside ? 2 : -2) });
    }
  }
  return moves;
}

export function legalMoves(position: Position): string[] {
  return candidates(position)
    .filter((move) => !inCheck(apply(position, move), position.turn))
    .map(uci)
    .sort();
}

export function playMove(position: Position, input: string): Position | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(input)) return null;
  const move = candidates(position).find((candidate) => uci(candidate) === input);
  if (!move) return null;
  const next = apply(position, move);
  return inCheck(next, position.turn) ? null : next;
}

export function boardRows(position: Position): string[][] {
  return Array.from({ length: 8 }, (_, row) => [
    String(8 - row),
    ...Array.from({ length: 8 }, (_, file) => position.board[(7 - row) * 8 + file] ?? "."),
  ]);
}

export function toFen(position: Position): string {
  const ranks = boardRows(position).map((row) =>
    row
      .slice(1)
      .join("")
      .replace(/\.+/g, (empty) => String(empty.length)),
  );
  return `${ranks.join("/")} ${position.turn === "white" ? "w" : "b"} ${position.castling || "-"} ${position.enPassant === null ? "-" : squareName(position.enPassant)} ${position.halfmove} ${position.fullmove}`;
}

export function repetitionKey(position: Position): string {
  const ep = position.enPassant;
  const hasLegalEp =
    ep !== null &&
    legalMoves(position).some((move) => {
      const from = (Number(move[1]) - 1) * 8 + move.charCodeAt(0) - 97;
      return (
        position.board[from]?.toLowerCase() === "p" &&
        move.slice(2, 4) === squareName(ep) &&
        from % 8 !== ep % 8
      );
    });
  return toFen({ ...position, enPassant: hasLegalEp ? ep : null })
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

export function insufficientMaterial(position: Position): boolean {
  const pieces = position.board.flatMap((piece, square) =>
    piece && piece.toLowerCase() !== "k" ? [{ kind: piece.toLowerCase(), square }] : [],
  );
  if (pieces.length === 0) return true;
  if (pieces.length === 1 && ["b", "n"].includes(pieces[0]?.kind ?? "")) return true;
  const colors = pieces.map(({ square }) => ((square % 8) + Math.floor(square / 8)) % 2);
  return pieces.every(({ kind }) => kind === "b") && colors.every((color) => color === colors[0]);
}

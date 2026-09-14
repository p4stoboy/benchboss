import {
  type CanvasTheme,
  DEFAULT_CANVAS_THEME,
  type GameCanvasRenderer,
} from "@benchboss/viewer/canvas";
import { type Piece, type Position, inCheck } from "./position";

// Decode only the public position already recorded by Chess revision 1.0.0.
function positionFromFen(fen: string): Position | undefined {
  if (fen.length > 256) return;
  const fields = fen.split(" ");
  if (fields.length !== 6) return;
  const [placement, side, castling, ep, halfmove, fullmove] = fields;
  if (
    !placement ||
    !side ||
    !castling ||
    !ep ||
    !halfmove ||
    !fullmove ||
    !/^[wb]$/.test(side) ||
    !/^(-|K?Q?k?q?)$/.test(castling) ||
    !/^(-|[a-h][36])$/.test(ep) ||
    !/^\d+$/.test(halfmove) ||
    !/^[1-9]\d*$/.test(fullmove) ||
    !Number.isSafeInteger(Number(halfmove)) ||
    !Number.isSafeInteger(Number(fullmove))
  )
    return;
  const ranks = placement.split("/");
  if (ranks.length !== 8) return;
  const board = Array.from({ length: 64 }, (): Piece | null => null);
  for (const [rank, row] of ranks.entries()) {
    if (!/^[prnbqkPRNBQK1-8]+$/.test(row) || /[1-8]{2}/.test(row)) return;
    let file = 0;
    for (const symbol of row) {
      if (/^[1-8]$/.test(symbol)) file += Number(symbol);
      else {
        if (file >= 8) return;
        board[(7 - rank) * 8 + file++] = symbol as Piece;
      }
      if (file > 8) return;
    }
    if (file !== 8) return;
  }
  if (
    board.filter((piece) => piece === "K").length !== 1 ||
    board.filter((piece) => piece === "k").length !== 1
  )
    return;
  return {
    board,
    turn: side === "w" ? "white" : "black",
    castling: castling === "-" ? "" : castling,
    enPassant: ep === "-" ? null : (Number(ep[1]) - 1) * 8 + ep.charCodeAt(0) - 97,
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
}

const polygon = (ctx: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]) => {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
};
const circle = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) => {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
};

// Self-contained vector silhouettes; rendering does not depend on fonts or remote assets.
function piece(
  ctx: CanvasRenderingContext2D,
  symbol: string,
  x: number,
  y: number,
  size: number,
  theme: Readonly<CanvasTheme>,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  const white = symbol === symbol.toUpperCase();
  ctx.fillStyle = white ? theme.light : theme.dark;
  ctx.strokeStyle = white ? theme.dark : theme.light;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  const kind = symbol.toLowerCase();
  if (kind === "n") {
    polygon(ctx, [
      [25, 76],
      [32, 57],
      [27, 47],
      [18, 50],
      [15, 39],
      [36, 22],
      [39, 11],
      [49, 21],
      [60, 25],
      [70, 41],
      [72, 76],
    ]);
    ctx.fillStyle = white ? theme.dark : theme.light;
    ctx.beginPath();
    ctx.arc(39, 33, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = white ? theme.light : theme.dark;
  } else {
    polygon(ctx, [
      [29, 77],
      [35, 62],
      [39, 43],
      [61, 43],
      [65, 62],
      [71, 77],
    ]);
    if (kind === "p") circle(ctx, 50, 31, 13);
    if (kind === "r")
      polygon(ctx, [
        [28, 43],
        [24, 20],
        [35, 20],
        [35, 29],
        [44, 29],
        [44, 20],
        [56, 20],
        [56, 29],
        [65, 29],
        [65, 20],
        [76, 20],
        [72, 43],
      ]);
    if (kind === "b") {
      ctx.beginPath();
      ctx.moveTo(50, 12);
      ctx.bezierCurveTo(18, 41, 36, 49, 50, 48);
      ctx.bezierCurveTo(64, 49, 82, 41, 50, 12);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(52, 23);
      ctx.lineTo(42, 36);
      ctx.stroke();
      circle(ctx, 50, 12, 3);
    }
    if (kind === "q") {
      polygon(ctx, [
        [32, 45],
        [23, 23],
        [41, 34],
        [50, 17],
        [59, 34],
        [77, 23],
        [68, 45],
      ]);
      for (const [cx, cy] of [
        [23, 21],
        [50, 15],
        [77, 21],
      ] as const)
        circle(ctx, cx, cy, 4);
    }
    if (kind === "k") {
      polygon(ctx, [
        [35, 45],
        [29, 31],
        [37, 26],
        [50, 31],
        [63, 26],
        [71, 31],
        [65, 45],
      ]);
      ctx.beginPath();
      ctx.moveTo(50, 10);
      ctx.lineTo(50, 30);
      ctx.moveTo(42, 17);
      ctx.lineTo(58, 17);
      ctx.stroke();
    }
  }
  polygon(ctx, [
    [27, 77],
    [73, 77],
    [77, 86],
    [23, 86],
  ]);
  ctx.restore();
}
const squareIndex = (square: string): number =>
  (Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97;

export const chessCanvas: GameCanvasRenderer = {
  identity: { protocolVersion: 1, runtimeVersion: "0.1.0", gameId: "chess", revision: "1.0.0" },
  aspectRatio: 1,
  render(ctx, view, { width, height, theme = DEFAULT_CANVAS_THEME }) {
    const fenBlocks = view.blocks.filter((block) => block.title === "FEN");
    const fen = fenBlocks[0];
    if (fenBlocks.length !== 1 || fen?.kind !== "text") return false;
    const position = positionFromFen(fen.text);
    if (!position) return false;
    const { board, turn } = position;
    const checkedKing = inCheck(position) ? board.indexOf(turn === "white" ? "K" : "k") : null;
    const moveBlocks = view.blocks.filter((block) => block.title === "Recent moves (UCI)");
    const moves = moveBlocks[0];
    const lastText =
      moveBlocks.length === 1 && moves?.kind === "list" ? moves.items.at(-1) : undefined;
    const lastMove =
      typeof lastText === "string" && lastText.length <= 64
        ? (lastText.match(/^\d+\.(?:\.\.)? ([a-h][1-8][a-h][1-8][qrbn]?)$/)?.[1] ?? null)
        : null;
    const side = Math.min(width, height);
    const margin = side * 0.055;
    const cell = (side - margin * 2) / 8;
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);
    const last =
      lastMove === null
        ? []
        : [squareIndex(lastMove.slice(0, 2)), squareIndex(lastMove.slice(2, 4))];
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const index = rank * 8 + file;
        const x = margin + file * cell;
        const y = margin + (7 - rank) * cell;
        ctx.fillStyle = (rank + file) % 2 === 0 ? theme.surface : theme.surfaceAlt;
        ctx.fillRect(x, y, cell, cell);
        if (last.includes(index)) {
          ctx.fillStyle = theme.accent;
          ctx.globalAlpha = 0.3;
          ctx.fillRect(x, y, cell, cell);
        }
        if (checkedKing === index) {
          ctx.fillStyle = theme.danger;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(x, y, cell, cell);
        }
        ctx.globalAlpha = 1;
        const symbol = board[index];
        if (symbol) piece(ctx, symbol, x, y, cell, theme);
      }
    }
    ctx.fillStyle = theme.text;
    ctx.font = `${Math.max(10, margin * 0.55)}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 8; i++) {
      ctx.fillText(String.fromCharCode(97 + i), margin + (i + 0.5) * cell, side - margin / 2);
      ctx.fillText(String(8 - i), margin / 2, margin + (i + 0.5) * cell);
    }
    return true;
  },
};

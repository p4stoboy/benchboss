import {
  type CanvasTheme,
  DEFAULT_CANVAS_THEME,
  type GameCanvasRenderer,
} from "@benchboss/viewer/canvas";
import type { ChessCanvasState } from "./presentation";

export type { ChessCanvasState } from "./presentation";

export function isChessCanvasState(value: unknown): value is ChessCanvasState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    Array.isArray(state.board) &&
    state.board.length === 64 &&
    state.board.every(
      (piece) => piece === null || (typeof piece === "string" && /^[prnbqkPRNBQK]$/.test(piece)),
    ) &&
    (state.turn === "white" || state.turn === "black") &&
    (state.lastMove === null ||
      (typeof state.lastMove === "string" &&
        /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(state.lastMove))) &&
    (state.checkedKing === null ||
      (Number.isInteger(state.checkedKing) &&
        (state.checkedKing as number) >= 0 &&
        (state.checkedKing as number) < 64))
  );
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

export const chessCanvas: GameCanvasRenderer<ChessCanvasState> = {
  id: "chess",
  version: 1,
  aspectRatio: 1,
  isState: isChessCanvasState,
  render(ctx, state, { width, height, theme = DEFAULT_CANVAS_THEME }) {
    const side = Math.min(width, height);
    const margin = side * 0.055;
    const cell = (side - margin * 2) / 8;
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);
    const last =
      state.lastMove === null
        ? []
        : [squareIndex(state.lastMove.slice(0, 2)), squareIndex(state.lastMove.slice(2, 4))];
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
        if (state.checkedKing === index) {
          ctx.fillStyle = theme.danger;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(x, y, cell, cell);
        }
        ctx.globalAlpha = 1;
        const symbol = state.board[index];
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
  },
};

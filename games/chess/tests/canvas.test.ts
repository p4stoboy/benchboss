import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { createRegistry } from "@benchboss/host";
import { chessCanvas } from "../src/canvas";
import { plugin } from "../src/plugin";
import { chessCanvasState } from "../src/presentation";
import { position } from "./fixtures";

const config = createRegistry([plugin]).buildConfig("canvas", "chess", [mkSeatId(0), mkSeatId(1)]);
const initial = () => plugin.makeGame().newMatch(config, "secret-seed");

test("canvas projection excludes internal state and ignores pending actions", () => {
  const state = initial();
  const projected = plugin.publicView(state).canvas;
  expect(projected).toEqual({
    renderer: "chess",
    version: 1,
    state: { ...chessCanvasState(state) },
  });
  expect(
    plugin.publicView({
      ...state,
      pending: { tool: "match.move", move: "e2e4" },
      repetitions: { secret: 999 },
    }).canvas,
  ).toEqual(projected);
  expect(JSON.stringify(projected)).not.toMatch(/pending|repetitions|secret|matchId/);
  expect(chessCanvas.isState(projected?.state)).toBe(true);
});

test("special positions draw directly from state, independent of previous frames", () => {
  const fens = [
    "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
    "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
    "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
  ];
  for (const fen of fens) {
    const state = { ...initial(), position: position(fen) };
    const data = chessCanvasState(state);
    expect(chessCanvas.isState(data)).toBe(true);
    const calls: string[] = [];
    const methods = [
      "save",
      "restore",
      "translate",
      "scale",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "fill",
      "stroke",
      "arc",
      "bezierCurveTo",
      "fillRect",
      "fillText",
    ];
    const ctx = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args: unknown[]) => {
          calls.push(`${method}:${args.join(",")}`);
        },
      ]),
    ) as unknown as CanvasRenderingContext2D;
    chessCanvas.render(ctx, data, { width: 400, height: 400 });
    const first = [...calls];
    calls.length = 0;
    chessCanvas.render(ctx, chessCanvasState(initial()), { width: 400, height: 400 });
    calls.length = 0;
    chessCanvas.render(ctx, data, { width: 400, height: 400 });
    expect(calls).toEqual(first);
    expect(calls.some((call) => call.startsWith("fillRect:"))).toBe(true);
  }
});

test("renderer rejects malformed board state", () => {
  const valid = chessCanvasState(initial());
  for (const state of [
    null,
    {},
    { ...valid, board: [] },
    { ...valid, board: Array(64).fill("X") },
    { ...valid, turn: "red" },
    { ...valid, lastMove: "h9h1" },
    { ...valid, checkedKing: 64 },
  ])
    expect(chessCanvas.isState(state)).toBe(false);
});

test("draws every piece with White at the bottom and highlights the checked king", () => {
  const data = chessCanvasState({
    ...initial(),
    position: position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"),
  });
  const pieces: number[][] = [];
  const squares: number[][] = [];
  const methods = [
    "save",
    "restore",
    "scale",
    "beginPath",
    "moveTo",
    "lineTo",
    "closePath",
    "fill",
    "stroke",
    "arc",
    "bezierCurveTo",
    "fillText",
  ];
  const ctx = {
    ...Object.fromEntries(methods.map((name) => [name, () => {}])),
    translate: (...point: number[]) => pieces.push(point),
    fillRect: (...rect: number[]) => squares.push(rect),
  } as unknown as CanvasRenderingContext2D;
  chessCanvas.render(ctx, data, { width: 400, height: 400 });
  expect(pieces).toHaveLength(3);
  const [whiteKing, queen, blackKing] = pieces;
  if (!whiteKing || !queen || !blackKing) throw Error("Missing pieces");
  expect(queen[0]).toBe(whiteKing[0]);
  expect(queen[1]).toBeLessThan(whiteKing[1] ?? 0);
  expect(blackKing[0]).toBeGreaterThan(queen[0] ?? 0);
  expect(blackKing[1]).toBeLessThan(queen[1] ?? 0);
  expect(squares).toHaveLength(66); // Background, 64 squares, checked-king highlight.
  expect(squares.at(-1)).toEqual(squares.at(-2));
  expect(squares.at(-1)?.slice(0, 2)).toEqual(blackKing);
});

test("uses the host palette and font without changing public chess state", () => {
  const state = chessCanvasState(initial());
  const copy = structuredClone(state);
  const palette = {
    background: "background",
    surface: "square-dark",
    surfaceAlt: "square-light",
    text: "label",
    light: "piece-white",
    dark: "piece-black",
    accent: "highlight",
    danger: "check",
    fontFamily: "Host Mono",
  };
  const colors: unknown[] = [];
  const ctx = Object.fromEntries(
    [
      "save",
      "restore",
      "translate",
      "scale",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "fill",
      "stroke",
      "arc",
      "bezierCurveTo",
      "fillRect",
      "fillText",
    ].map((name) => [name, () => {}]),
  );
  Object.defineProperty(ctx, "fillStyle", { set: (value) => colors.push(value) });
  chessCanvas.render(ctx as unknown as CanvasRenderingContext2D, state, {
    width: 400,
    height: 400,
    theme: palette,
  });
  for (const color of [
    palette.background,
    palette.surface,
    palette.surfaceAlt,
    palette.text,
    palette.light,
    palette.dark,
  ])
    expect(colors).toContain(color);
  expect(String(ctx.font)).toContain(palette.fontFamily);
  expect(state).toEqual(copy);
});

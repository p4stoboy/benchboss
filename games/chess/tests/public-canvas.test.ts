import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { createRegistry } from "@benchboss/host";
import type { SpectatorView } from "@benchboss/protocol";
import { chessCanvas } from "../src/canvas";
import { plugin } from "../src/plugin";
import { position } from "./fixtures";

const config = createRegistry([plugin]).buildConfig("recorded", "chess", [
  mkSeatId(0),
  mkSeatId(1),
]);
const initial = () => plugin.makeGame().newMatch(config, "private-seed");
const draw = (view: SpectatorView) => {
  const squares: number[][] = [];
  const pieces: number[][] = [];
  const ctx = {
    ...Object.fromEntries(
      [
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
      ].map((name) => [name, () => {}]),
    ),
    fillRect: (...args: number[]) => squares.push(args),
    translate: (...args: number[]) => pieces.push(args),
  } as unknown as CanvasRenderingContext2D;
  return { ok: chessCanvas.render(ctx, view, { width: 400, height: 400 }), squares, pieces };
};
const withFen = (view: SpectatorView, fen: string): SpectatorView => ({
  ...view,
  blocks: view.blocks.map((block) =>
    block.title === "FEN" ? { kind: "text", title: "FEN", text: fen } : block,
  ),
});

const positions = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
  "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
  "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
  "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
  "4n1k1/5bpp/p7/5P2/3B4/1P5P/r4PP1/5BK1 w - - 0 34",
];

describe("Chess rendering from existing public views", () => {
  test.each(positions)("draws %s from only the existing public contract", (fen) => {
    const state = { ...initial(), position: position(fen), moves: ["c2a2"] };
    const recorded = plugin.publicView(state);
    const before = structuredClone(recorded);
    const result = draw(recorded);
    expect(result.ok).toBe(true);
    expect(result.pieces).toHaveLength(state.position.board.filter(Boolean).length);
    expect(recorded).toEqual(before);
    expect(recorded).not.toHaveProperty("canvas");
  });

  test("rejects missing, ambiguous or malformed FEN without fabricating a board", () => {
    const view = plugin.publicView(initial());
    for (const fen of [
      "",
      "x".repeat(300),
      "8/8 w - - 0 1",
      "8/8/8/8/8/8/8/8 w - - 0 1",
      "4k3/8/8/8/8/8/8/4KK2 w - - 0 1",
      "4k3/8/8/8/8/8/8/4K2X w - - 0 1",
      "4k3/8/8/8/8/8/8/4K3 red - - 0 1",
      "4k3/8/8/8/8/8/8/4K3 w invalid - 0 1",
      "4k3/8/8/8/8/8/8/4K3 w - a9 0 1",
      "4k3/8/8/8/8/8/8/4K3 w - - -1 1",
      "4k3/8/8/8/8/8/8/4K3 w - - 0 0",
    ])
      expect(draw(withFen(view, fen))).toEqual({ ok: false, squares: [], pieces: [] });
    expect(draw({ ...view, blocks: [] }).ok).toBe(false);
    const fenBlock = view.blocks.find((block) => block.title === "FEN");
    if (!fenBlock) throw Error("Missing test FEN");
    expect(draw({ ...view, blocks: [...view.blocks, fenBlock] }).ok).toBe(false);
  });

  test("keeps the board when the optional recorded move highlight is unavailable", () => {
    const view = plugin.publicView(initial());
    for (const items of [[], ["not a move"], ["33... c2a9"], ["33... c2a2"]]) {
      const result = draw({
        ...view,
        blocks: view.blocks.map((block) => (block.kind === "list" ? { ...block, items } : block)),
      });
      expect(result.ok).toBe(true);
      expect(result.squares).toHaveLength(items[0] === "33... c2a2" ? 67 : 65);
    }
  });
});

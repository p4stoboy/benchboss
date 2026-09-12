import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { gameConfig } from "../../tests/config";
import { type ChessState, makeChess } from "../src/game";
import { plugin } from "../src/plugin";
import { repetitionKey } from "../src/position";
import { position } from "./fixtures";

const game = makeChess();
const config = (rules: Record<string, unknown> = {}) =>
  gameConfig(plugin.manifest, "chess-test", [mkSeatId(0), mkSeatId(1)], rules);
const start = (rules: Record<string, unknown> = {}) => game.newMatch(config(rules), "chess-seed");
function move(state: ChessState, uci: string): ChessState {
  const submitted = game.submit(
    state,
    state.players[state.position.turn],
    { move: uci },
    "match.move",
  );
  expect(submitted.accepted).toBe(true);
  return game.step(submitted.state);
}
function fromFen(fen: string, overrides: Partial<ChessState> = {}): ChessState {
  const board = position(fen);
  return { ...start(), position: board, repetitions: { [repetitionKey(board)]: 1 }, ...overrides };
}

test("colors are seeded, public, stable, and include both seats", () => {
  const initial = start();
  expect(initial).toEqual(start());
  expect(Object.values(initial.players).sort()).toEqual(config().seats);
  expect(initial.position.turn).toBe("white");
  const colors = Array.from(
    { length: 20 },
    (_, i) => game.newMatch(config(), String(i)).players.white,
  );
  expect(colors).toContain(mkSeatId(0));
  expect(colors).toContain(mkSeatId(1));
});

test("invalid rule shapes, limits and seats fail before a match exists", () => {
  for (const rules of [
    { maxPlies: 0 },
    { maxPlies: -1 },
    { maxPlies: 1001 },
    { maxPlies: 2.5 },
    { maxPlies: "5" },
    { initialFen: "anything" },
    { maxPlies: null },
  ])
    expect(() => start(rules)).toThrow();
  for (const seats of [
    [],
    [mkSeatId(0)],
    [mkSeatId(0), mkSeatId(0)],
    [mkSeatId(0), mkSeatId(1), mkSeatId(2)],
  ])
    expect(() => game.newMatch({ ...config(), seats }, "seed")).toThrow();
});

test("the direct replay boundary rejects unknown tools, malformed actions and inactive seats", () => {
  const state = start();
  const before = structuredClone(state);
  const white = state.players.white;
  for (const [seat, input, tool] of [
    [white, null, "match.move"],
    [white, [], "match.move"],
    [white, {}, "match.move"],
    [white, { move: "e2e4", extra: true }, "match.move"],
    [white, { move: "e2e5" }, "match.move"],
    [white, { move: "e2e4" }, "match.resign"],
    [white, {}, "match.unknown"],
    [white, { move: "e2e4" }, undefined],
    [white, {}, undefined],
    [state.players.black, { move: "e7e5" }, "match.move"],
    [state.players.black, {}, "match.resign"],
    [mkSeatId(99), {}, "match.resign"],
  ] as const) {
    const submitted = game.submit(state, seat, input, tool as string);
    expect(submitted.accepted).toBe(false);
    expect(submitted.state).toBe(state);
  }
  expect(state).toEqual(before);
});

test("submission waits for resolution and pending actions cannot be overwritten or disclosed", () => {
  const state = start();
  const accepted = game.submit(state, state.players.white, { move: "e2e4" }, "match.move");
  expect(accepted.accepted).toBe(true);
  expect(accepted.state.position).toEqual(state.position);
  expect(game.legalActions(accepted.state, state.players.white)).toEqual([]);
  expect(game.submit(accepted.state, state.players.white, {}, "match.resign").accepted).toBe(false);
  expect(plugin.publicView(accepted.state)).toEqual(plugin.publicView(state));
  expect(game.observe(accepted.state, state.players.black).publicState.moves).toEqual([]);
  expect(game.step(state)).toBe(state);
  const resolved = game.step(accepted.state);
  expect(resolved.moves).toEqual(["e2e4"]);
  expect(resolved.position.turn).toBe("black");
  expect(resolved.pending).toBeNull();
});

test("Fool's Mate produces a Black win even at the ply limit and terminal rejects further commands", () => {
  let state = start({ maxPlies: 4 });
  for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) state = move(state, uci);
  expect(state.outcome).toEqual({ reason: "checkmate", winner: "black" });
  expect(game.score(state)).toEqual({ [state.players.white]: 0, [state.players.black]: 1 });
  expect(
    plugin
      .publicView(state)
      .result?.seats.map((seat) => seat.outcome)
      .sort(),
  ).toEqual(["loss", "win"]);
  for (const seat of state.seats) {
    expect(game.legalActions(state, seat)).toEqual([]);
    expect(game.submit(state, seat, {}, "match.resign").accepted).toBe(false);
  }
  expect(game.step(state)).toBe(state);
});

test("resignation and the safe default award the opponent the win", () => {
  const state = start();
  const fallback = plugin.safeDefault(state, state.players.white);
  const submitted = game.submit(state, state.players.white, fallback.input, fallback.tool);
  const end = game.step(submitted.state);
  expect(end.outcome).toEqual({ reason: "resignation", winner: "black" });
  expect(end.moves).toEqual([]);
});

describe("draw adjudication", () => {
  test("threefold counts the initial position and retained move history", () => {
    let state = start();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8"]) state = move(state, uci);
      if (cycle === 0) expect(state.phase).toBe("move");
    }
    expect(state.outcome).toEqual({ reason: "threefold-repetition", winner: null });
    expect(Object.values(game.score(state))).toEqual([0.5, 0.5]);
    expect(
      plugin
        .publicView(state)
        .result?.seats.every((seat) => seat.outcome === "draw" && seat.placement === 1),
    ).toBe(true);
  });
  test("a quiet-move draw occurs at 100 plies but captures and pawn moves reset the counter", () => {
    const fen = "4k3/8/8/8/8/8/P7/R3K3 w - - 99 80";
    expect(move(fromFen(fen), "a1b1").outcome?.reason).toBe("fifty-move-rule");
    expect(move(fromFen(fen), "a2a3").phase).toBe("move");
    const capture = move(fromFen("4k3/8/8/8/8/8/n7/R3K3 w - - 99 80"), "a1a2");
    expect(capture.position.halfmove).toBe(0);
    expect(capture.phase).toBe("move");
  });
  test("stalemate, insufficient material and the configured move cap are distinct draws", () => {
    expect(move(fromFen("k7/8/1QK5/8/8/8/8/8 w - - 0 1"), "b6c7").outcome?.reason).toBe(
      "stalemate",
    );
    expect(move(fromFen("4k3/8/8/8/8/8/3b4/4K3 w - - 0 1"), "e1d2").outcome?.reason).toBe(
      "insufficient-material",
    );
    expect(move(start({ maxPlies: 1 }), "e2e4").outcome?.reason).toBe("ply-limit");
  });
  test("checkmate takes priority over the quiet-move boundary", () => {
    expect(move(fromFen("7k/5K2/6Q1/8/8/8/8/8 w - - 99 90"), "g6g7").outcome).toEqual({
      reason: "checkmate",
      winner: "white",
    });
  });
});

test("observations are full-information snapshots without exposing or aliasing execution state", () => {
  const state = move(start(), "e2e4");
  const before = structuredClone(state);
  const white = game.observe(state, state.players.white);
  const black = game.observe(state, state.players.black);
  expect(white.publicState).toEqual(black.publicState);
  expect(white.privateState).toEqual({});
  expect(black.privateState).toEqual({});
  expect(white.legalTools).toEqual([]);
  expect(black.legalTools).toContain("match.move");
  expect(white.publicState.fen).toContain(" b KQkq e3 ");
  white.publicState.moves.push("tampered");
  const firstRank = white.publicState.board[0];
  if (!firstRank) throw Error("Missing board rank");
  firstRank[1] = "tampered";
  expect(state).toEqual(before);
  expect(JSON.stringify([white, black, plugin.publicView(state)])).not.toContain("chess-seed");
});

import { describe, expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import {
  type Position,
  inCheck,
  initialPosition,
  insufficientMaterial,
  legalMoves,
  playMove,
  repetitionKey,
  toFen,
} from "../src/position";
import { position } from "./fixtures";

function play(state: Position, move: string): Position {
  const next = playMove(state, move);
  if (!next) throw Error(`Rejected fixture move ${move}`);
  return next;
}
function perft(state: Position, depth: number): number {
  if (depth === 0) return 1;
  return legalMoves(state).reduce((sum, move) => sum + perft(play(state, move), depth - 1), 0);
}

// Independent legal-tree totals from chess.js's published perft suite:
// https://github.com/jhlywa/chess.js/blob/master/__tests__/perft.test.ts
// These are rule fixtures, not tuned implementation constants.
describe("legal chess move trees", () => {
  const cases: [string, string, number, number][] = [
    ["initial", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 3, 8902],
    [
      "castling and pins",
      "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
      3,
      97862,
    ],
    ["rook and pawn endgame", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 4, 43238],
    [
      "promotion and check evasion",
      "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
      3,
      62379,
    ],
    [
      "middlegame",
      "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
      3,
      89890,
    ],
    ["en passant", "rnbqkbnr/p3pppp/2p5/1pPp4/3P4/8/PP2PPPP/RNBQKBNR w KQkq b6 0 4", 3, 23509],
  ];
  for (const [name, fen, depth, count] of cases)
    test(name, () => {
      expect(perft(position(fen), depth)).toBe(count);
    }, 60000);
});

test("initial FEN is standard and illegal inputs leave it intact", () => {
  const start = initialPosition();
  const before = structuredClone(start);
  expect(toFen(start)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  for (const move of ["e2e5", "e7e5", "e1e2", "e2e4q", "E2E4", "e2e4junk", "a0a1"]) {
    expect(playMove(start, move)).toBeNull();
    expect(start).toEqual(before);
  }
});

test("en passant captures only on the next move and cannot expose its own king", () => {
  let state = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
  expect(legalMoves(state)).toContain("e5d6");
  const captured = play(state, "e5d6");
  expect(toFen(captured)).toBe("4k3/8/3P4/8/8/8/8/4K3 b - - 0 2");
  state = play(play(state, "e1f1"), "e8f8");
  expect(legalMoves(state)).not.toContain("e5d6");
  expect(legalMoves(position("4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 2"))).not.toContain("e5d6");
});

test("castling moves the rook and permanently consumes rights", () => {
  const start = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  expect(legalMoves(start)).toContain("e1g1");
  expect(legalMoves(start)).toContain("e1c1");
  expect(toFen(play(start, "e1g1"))).toBe("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
  expect(toFen(play(start, "e1c1"))).toBe("r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1");
  let moved = start;
  for (const move of ["h1h2", "h8h7", "h2h1", "h7h8"]) moved = play(moved, move);
  expect(legalMoves(moved)).not.toContain("e1g1");
  expect(play(start, "a1a8").castling).toBe("Kk");
});

test("castling is forbidden out of, through or into check, and without its rook", () => {
  for (const fen of [
    "4r1k1/8/8/8/8/8/8/4K2R w K - 0 1",
    "5rk1/8/8/8/8/8/8/4K2R w K - 0 1",
    "6rk/8/8/8/8/8/8/4K2R w K - 0 1",
    "4k3/8/8/8/8/8/8/4K3 w K - 0 1",
  ])
    expect(legalMoves(position(fen))).not.toContain("e1g1");
});

test("all four promotions are explicit for advances and captures for both colors", () => {
  for (const [fen, prefix] of [
    ["1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7"],
    ["4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1", "a2"],
  ] as const) {
    const state = position(fen);
    const pawnMoves = legalMoves(state).filter((move) => move.startsWith(prefix));
    expect(pawnMoves).toHaveLength(8);
    for (const move of pawnMoves) {
      expect(["q", "r", "b", "n"]).toContain(move.charAt(4));
      expect(playMove(state, move.slice(0, 4))).toBeNull();
      expect(
        play(state, move).board.filter((piece) => piece?.toLowerCase() === move.charAt(4)),
      ).toHaveLength(move.charAt(4) === "r" && move[2] === "a" ? 2 : 1);
    }
  }
});

test("repetition identity includes only effective en passant and castling rights", () => {
  const noCapture = position("4k3/8/8/3p4/8/8/8/4K3 w - d6 0 2");
  expect(repetitionKey(noCapture)).toBe(
    repetitionKey({ ...noCapture, enPassant: null, halfmove: 42, fullmove: 70 }),
  );
  const available = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
  expect(repetitionKey(available)).not.toBe(repetitionKey({ ...available, enPassant: null }));
  const pinned = position("4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
  expect(repetitionKey(pinned)).toBe(repetitionKey({ ...pinned, enPassant: null }));
  expect(repetitionKey(initialPosition())).not.toBe(
    repetitionKey({ ...initialPosition(), castling: "" }),
  );
  expect(repetitionKey(initialPosition())).not.toBe(
    repetitionKey({ ...initialPosition(), turn: "black" }),
  );
});

test("material draws do not discard cooperative mating material", () => {
  for (const fen of [
    "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    "4k3/8/8/8/8/8/8/2B1K3 w - - 0 1",
    "4k3/8/8/8/8/8/8/2N1K3 w - - 0 1",
    "4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1",
  ])
    expect(insufficientMaterial(position(fen))).toBe(true);
  for (const fen of [
    "4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1",
    "4k3/8/8/8/8/8/8/2BNK3 w - - 0 1",
    "2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1",
  ])
    expect(insufficientMaterial(position(fen))).toBe(false);
});

test("generated legal games preserve kings, alternate turns and never leave the mover in check", () => {
  for (let seed = 0; seed < 8; seed++) {
    const rng = createRng(`chess-invariants:${seed}`);
    let state = initialPosition();
    for (let ply = 0; ply < 150; ply++) {
      const before = structuredClone(state);
      const moves = legalMoves(state);
      if (!moves.length) break;
      const next = play(state, rng.pick(moves));
      expect(state).toEqual(before);
      expect(next.turn).not.toBe(state.turn);
      expect(inCheck(next, state.turn)).toBe(false);
      expect(next.board.filter((piece) => piece === "K")).toHaveLength(1);
      expect(next.board.filter((piece) => piece === "k")).toHaveLength(1);
      expect(next.board.filter(Boolean).length).toBeLessThanOrEqual(
        state.board.filter(Boolean).length,
      );
      state = next;
    }
  }
});

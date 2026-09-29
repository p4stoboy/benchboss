import { describe, expect, test } from "bun:test";
import type { MatchConfig, SeatId } from "@benchboss/core";
import { createLobby } from "../src/lobby";

const COUNTS: Record<string, number[]> = {
  fixed: [2],
  range: [2, 3, 4, 5, 6],
  discrete: [5, 7, 9],
};
const deps = {
  nextMatchId: (gameId: string) => `${gameId}:m`,
  nextSeed: () => "seed",
  buildConfig: (matchId: string, gameId: string, seats: SeatId[]) =>
    ({ matchId, gameId, seats }) as unknown as MatchConfig,
};
const lobby = (lockWindowMs?: number) =>
  createLobby({ seatCountsForGame: (id) => COUNTS[id] ?? [], lockWindowMs });
const join = (l: ReturnType<typeof lobby>, gameId: string, ids: string[], at: number) => {
  for (const id of ids) l.enqueue({ agentId: id, principalId: id, gameId }, at);
};
const sizes = (l: ReturnType<typeof lobby>, at: number, extra = {}) =>
  l.matchmake({ ...deps, ...extra }, at).map((s) => s.assignments.length);

describe("lobby lock countdown", () => {
  test("a static seat count starts the moment enough agents queue, with no countdown", () => {
    const l = lobby();
    join(l, "fixed", ["a"], 0);
    expect(l.locksAt("fixed")).toBeNull();
    expect(sizes(l, 0)).toEqual([]);
    join(l, "fixed", ["b", "c"], 1);
    expect(l.locksAt("fixed")).toBeNull();
    expect(sizes(l, 1)).toEqual([2]);
    expect(l.queued("fixed")).toBe(1);
  });

  test("a variable queue counts down from the arrival that completed the minimum", () => {
    const l = lobby(30_000);
    join(l, "range", ["a"], 1_000);
    expect(l.locksAt("range")).toBeNull();
    join(l, "range", ["b"], 5_000);
    expect(l.locksAt("range")).toBe(35_000);
    join(l, "range", ["c"], 20_000);
    expect(l.locksAt("range")).toBe(35_000);
    expect(sizes(l, 34_999)).toEqual([]);
    expect(sizes(l, 35_000)).toEqual([3]);
    expect(l.queued("range")).toBe(0);
    expect(l.locksAt("range")).toBeNull();
  });

  test("reaching the maximum locks immediately and leftovers start their own countdown", () => {
    const l = lobby(30_000);
    join(l, "range", ["a", "b", "c", "d", "e", "f"], 0);
    join(l, "range", ["g", "h"], 10);
    const specs = l.matchmake(deps, 10);
    expect(specs.map((s) => s.assignments.map((a) => a.agentId))).toEqual([
      ["a", "b", "c", "d", "e", "f"],
    ]);
    expect(l.queued("range")).toBe(2);
    expect(l.locksAt("range")).toBe(30_010);
  });

  test("discrete seat counts lock at the largest supported size that fits", () => {
    const l = lobby(30_000);
    join(l, "discrete", ["1", "2", "3", "4", "5", "6", "7", "8"], 0);
    expect(sizes(l, 29_999)).toEqual([]);
    expect(sizes(l, 30_000)).toEqual([7]);
    expect(l.queued("discrete")).toBe(1);
    expect(l.locksAt("discrete")).toBeNull();
  });

  test("an agent leaving below the minimum cancels the countdown and a return restarts it", () => {
    const l = lobby(30_000);
    join(l, "range", ["a"], 0);
    join(l, "range", ["b"], 100);
    expect(l.locksAt("range")).toBe(30_100);
    l.removeAgent("a");
    expect(l.locksAt("range")).toBeNull();
    expect(sizes(l, 60_000)).toEqual([]);
    join(l, "range", ["c"], 60_000);
    expect(l.locksAt("range")).toBe(90_000);
  });

  test("a failed admission returns agents with their original arrival so the lock stays due", () => {
    const l = lobby(30_000);
    join(l, "range", ["a", "b"], 0);
    const [spec] = l.matchmake({ ...deps, reserve: true }, 30_000);
    expect(spec?.assignments.length).toBe(2);
    expect(l.hasAgent("a")).toBe(true);
    l.settle(spec?.matchId as string, false);
    expect(l.locksAt("range")).toBe(30_000);
    expect(sizes(l, 30_001)).toEqual([2]);
  });

  test("the match bound stops drawing even when more locks are due", () => {
    const l = lobby(0);
    join(l, "fixed", ["a", "b", "c", "d"], 0);
    expect(sizes(l, 0, { maxMatches: 1 })).toEqual([2]);
    expect(l.queued("fixed")).toBe(2);
  });

  test("snapshots expose the policy and the pending lock", () => {
    const l = lobby(30_000);
    join(l, "range", ["a", "b"], 5);
    expect(l.snapshot()).toEqual([
      {
        gameId: "range",
        queued: 2,
        minSeats: 2,
        maxSeats: 6,
        oldestEnqueuedAt: 5,
        locksAt: 30_005,
      },
    ]);
    expect(() => l.locksAt("unknown")).toThrow("invalid seat counts");
  });
});

import { expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import { TEAM_SIZE } from "../src/classes";
import { generateMap } from "../src/generate";
import { chebyshev, closeRound, mapCenter, zoneRadius } from "../src/map";
import { inZone, zoneAt, zoneSchedule } from "../src/zone";
import { game, newMatch } from "./helpers";

const contains = (
  outer: { center: { x: number; y: number }; radius: number },
  inner: { center: { x: number; y: number }; radius: number },
): boolean => chebyshev(outer.center, inner.center) + inner.radius <= outer.radius;

test("every zone stage lies inside the previous one, keeps the radius rule and ends on one tile", () => {
  for (const seats of [2, 5, 12])
    for (const maxRounds of [4, 12, 40, 200])
      for (const seed of ["a", "b"]) {
        const map = generateMap(createRng(`zone:${seed}:${seats}`), seats, 100, TEAM_SIZE);
        const zones = zoneSchedule(createRng(`${seed}:${maxRounds}`), map, maxRounds);
        const close = closeRound(maxRounds);
        expect(zones).toHaveLength(close + 1);
        expect(zones[1]).toEqual({ center: mapCenter(map), radius: zoneRadius(map, maxRounds, 1) });
        expect(zones[0]).toEqual(zones[1] as never);
        for (let round = 2; round <= close; round++) {
          const stage = zones[round];
          const previous = zones[round - 1];
          if (!stage || !previous) throw Error("missing stage");
          expect(stage.radius).toBe(zoneRadius(map, maxRounds, round));
          expect(contains(previous, stage)).toBe(true);
          expect(stage.center.x).toBeGreaterThanOrEqual(0);
          expect(stage.center.y).toBeGreaterThanOrEqual(0);
          expect(stage.center.x).toBeLessThan(map.width);
          expect(stage.center.y).toBeLessThan(map.height);
        }
        expect(zones[close]?.radius).toBe(0);
        // The first stage covers the whole map.
        for (let y = 0; y < map.height; y++)
          for (let x = 0; x < map.width; x++)
            expect(inZone(zones[1] as never, { x, y })).toBe(true);
      }
});

test("the final tile moves with the seed and is not always the map centre", () => {
  const map = generateMap(createRng("zone:final"), 5, 300, TEAM_SIZE);
  const finals = new Set(
    ["a", "b", "c", "d", "e", "f"].map((seed) => {
      const zones = zoneSchedule(createRng(seed), map, 40);
      const last = zones[zones.length - 1];
      return `${last?.center.x},${last?.center.y}`;
    }),
  );
  expect(finals.size).toBeGreaterThan(1);
  const centre = mapCenter(map);
  expect(finals.has(`${centre.x},${centre.y}`) && finals.size === 1).toBe(false);
});

test("a match carries its schedule and the observation names the next stage", () => {
  const state = newMatch(3, "zone:match", { maxRounds: 8 });
  expect(state.zones).toEqual(zoneSchedule(createRng("zone:match").fork("zone"), state.map, 8));
  const close = closeRound(8);
  expect(zoneAt(state, 0)).toEqual(zoneAt(state, 1));
  expect(zoneAt(state, close + 5)).toEqual(zoneAt(state, close));
  const at = { ...state, round: 2 };
  expect(zoneAt(at, 2)).toEqual(state.zones[2] as never);
  expect(zoneAt(at, 3)).toEqual(state.zones[3] as never);
  const seat = state.seats[0];
  if (!seat) throw Error("missing seat");
  const observed = game.observe(at, seat).publicState.zone;
  if (!observed) throw Error("missing zone");
  expect(observed.center).toEqual(zoneAt(at, 2).center);
  expect(observed.radius).toBe(zoneAt(at, 2).radius);
  expect(observed.nextCenter).toEqual(zoneAt(at, 3).center);
  expect(observed.nextRadius).toBe(zoneAt(at, 3).radius);
});

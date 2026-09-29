import { expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import { TEAM_SIZE } from "../src/classes";
import {
  closeRound,
  generateMap,
  key,
  mapSize,
  stepCost,
  stormDamage,
  zoneCenter,
  zoneRadius,
} from "../src/map";

test("map area covers every seat's tile allowance with a near-square shape", () => {
  for (const seats of [2, 3, 5, 8, 13, 30])
    for (const tilesPerSeat of [9, 25, 100]) {
      const { width, height } = mapSize(seats, tilesPerSeat);
      expect(width * height).toBeGreaterThanOrEqual(seats * tilesPerSeat);
      expect(Math.abs(width - height)).toBeLessThanOrEqual(1);
    }
});

test("generated maps are seeded, give every team distinct spawns and connect all spawns", () => {
  for (const seats of [2, 7, 30]) {
    const map = generateMap(createRng(`map:${seats}`), seats, 25, TEAM_SIZE);
    expect(map).toEqual(generateMap(createRng(`map:${seats}`), seats, 25, TEAM_SIZE));
    expect(map.spawns).toHaveLength(seats);
    const all = map.spawns.flat();
    expect(all).toHaveLength(seats * TEAM_SIZE);
    expect(new Set(all.map(key)).size).toBe(all.length);
    for (const tile of all) expect(map.tiles[tile.y]?.[tile.x]?.kind).not.toBe("wall");
    // Reachability from the first spawn to every other spawn over passable steps.
    const start = all[0] as { x: number; y: number };
    const seen = new Set([key(start)]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift() as { x: number; y: number };
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const next = { x: current.x + dx, y: current.y + dy };
          if ((dx || dy) && stepCost(map, current, next) !== null && !seen.has(key(next))) {
            seen.add(key(next));
            queue.push(next);
          }
        }
    }
    for (const tile of all) expect(seen.has(key(tile))).toBe(true);
  }
});

test("different seeds change the map", () => {
  expect(generateMap(createRng("a"), 4, 25, TEAM_SIZE)).not.toEqual(
    generateMap(createRng("b"), 4, 25, TEAM_SIZE),
  );
});

test("steps climb at most one level, cost more uphill and never enter walls", () => {
  const map = generateMap(createRng("steps"), 2, 25, TEAM_SIZE);
  map.tiles[0] = [
    { h: 0, kind: "open" },
    { h: 1, kind: "open" },
    { h: 3, kind: "open" },
    { h: 0, kind: "wall" },
  ];
  const at = (x: number) => ({ x, y: 0 });
  expect(stepCost(map, at(0), at(1))).toBe(2);
  expect(stepCost(map, at(1), at(0))).toBe(1);
  expect(stepCost(map, at(1), at(2))).toBeNull();
  expect(stepCost(map, at(2), at(1))).toBeNull();
  expect(stepCost(map, at(2), at(3))).toBeNull();
  expect(stepCost(map, at(0), at(2))).toBeNull();
  expect(stepCost(map, at(0), { x: -1, y: 0 })).toBeNull();
});

test("the zone shrinks monotonically to the centre tile before the round cap and the storm never eases", () => {
  const map = generateMap(createRng("zone"), 6, 25, TEAM_SIZE);
  for (const maxRounds of [4, 12, 40, 200]) {
    let previous = Number.POSITIVE_INFINITY;
    for (let round = 1; round <= maxRounds; round++) {
      const radius = zoneRadius(map, maxRounds, round);
      expect(radius).toBeLessThanOrEqual(previous);
      expect(radius).toBeGreaterThanOrEqual(0);
      previous = radius;
      expect(stormDamage(round + 1)).toBeGreaterThanOrEqual(stormDamage(round));
      expect(stormDamage(round)).toBeGreaterThan(0);
    }
    expect(zoneRadius(map, maxRounds, closeRound(maxRounds))).toBe(0);
    expect(closeRound(maxRounds)).toBeLessThanOrEqual(maxRounds);
    expect(zoneRadius(map, maxRounds, 1)).toBeGreaterThanOrEqual(
      Math.max(zoneCenter(map).x, zoneCenter(map).y),
    );
  }
});

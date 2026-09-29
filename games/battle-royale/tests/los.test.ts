import { expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import { generateMap } from "../src/generate";
import { hasLineOfSight } from "../src/los";
import { mapFromRows } from "./helpers";

test("line of sight is symmetric on generated terrain", () => {
  const rng = createRng("los-symmetry");
  for (let i = 0; i < 6; i++) {
    const map = generateMap(rng.fork(`map:${i}`), 6, 25, 3);
    for (let sample = 0; sample < 300; sample++) {
      const a = { x: rng.int(map.width), y: rng.int(map.height) };
      const b = { x: rng.int(map.width), y: rng.int(map.height) };
      expect(hasLineOfSight(map, a, b)).toBe(hasLineOfSight(map, b, a));
    }
  }
});

test("adjacent tiles and flat open ground always see each other", () => {
  const map = mapFromRows(["0000", "0000", "0000"]);
  expect(hasLineOfSight(map, { x: 0, y: 0 }, { x: 3, y: 2 })).toBe(true);
  const walled = mapFromRows(["0#0"]);
  expect(hasLineOfSight(walled, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(true);
});

test("walls block sight while cover does not", () => {
  expect(hasLineOfSight(mapFromRows(["0#0"]), { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
  expect(hasLineOfSight(mapFromRows(["0+0"]), { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(true);
});

test("a ridge higher than both observers blocks; standing on the ridge sees over it", () => {
  const ridge = mapFromRows(["0100"]);
  expect(hasLineOfSight(ridge, { x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
  expect(hasLineOfSight(ridge, { x: 1, y: 0 }, { x: 3, y: 0 })).toBe(true);
  // A second ridge of equal height still rises above a descending sight line.
  expect(hasLineOfSight(mapFromRows(["01010"]), { x: 1, y: 0 }, { x: 4, y: 0 })).toBe(false);
  const plateau = mapFromRows(["11100"]);
  expect(hasLineOfSight(plateau, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  const tall = mapFromRows(["00300"]);
  expect(hasLineOfSight(tall, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
});

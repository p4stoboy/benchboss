import { expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import { generateMap } from "../src/generate";
import { chebyshev, key, stepCost } from "../src/map";
import { reachableTiles } from "../src/path";
import { mapFromRows } from "./helpers";

test("every reach has a valid path whose step costs sum to its cost within the budget", () => {
  const rng = createRng("reach");
  for (let i = 0; i < 5; i++) {
    const map = generateMap(rng.fork(`map:${i}`), 5, 25, 3);
    const origin = map.spawns[0]?.[0] as { x: number; y: number };
    const blocked = new Set([key(map.spawns[1]?.[0] as { x: number; y: number })]);
    const passable = new Set([key(map.spawns[0]?.[1] as { x: number; y: number })]);
    const budget = 5;
    const reaches = reachableTiles(map, origin, budget, blocked, passable);
    expect(reaches.length).toBeGreaterThan(0);
    for (const reach of reaches) {
      expect(reach.cost).toBeLessThanOrEqual(budget);
      expect(reach.cost).toBeGreaterThan(0);
      expect(blocked.has(key(reach))).toBe(false);
      expect(passable.has(key(reach))).toBe(false);
      let at = origin;
      let total = 0;
      for (const step of reach.path) {
        expect(chebyshev(at, step)).toBe(1);
        expect(blocked.has(key(step))).toBe(false);
        const cost = stepCost(map, at, step);
        expect(cost).not.toBeNull();
        total += cost ?? 0;
        at = step;
      }
      expect(at).toEqual({ x: reach.x, y: reach.y });
      expect(total).toBe(reach.cost);
    }
    expect(reaches).toEqual(reachableTiles(map, origin, budget, blocked, passable));
  }
});

test("reaches are cost-optimal: no cheaper route exists through any neighbour", () => {
  const map = mapFromRows(["0000", "0110", "0#00", "0000"]);
  const reaches = reachableTiles(map, { x: 0, y: 0 }, 6, new Set(), new Set());
  const cost = new Map(reaches.map((r) => [key(r), r.cost]));
  cost.set(key({ x: 0, y: 0 }), 0);
  for (const reach of reaches)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const from = { x: reach.x + dx, y: reach.y + dy };
        const via = cost.get(key(from));
        const step = via === undefined ? null : stepCost(map, from, reach);
        if (step !== null && via !== undefined) expect(reach.cost).toBeLessThanOrEqual(via + step);
      }
  expect(cost.has(key({ x: 1, y: 2 }))).toBe(false);
});

test("allies can be crossed but not ended on and enemies neither", () => {
  const map = mapFromRows(["00000"]);
  const ally = new Set([key({ x: 1, y: 0 })]);
  const enemy = new Set([key({ x: 1, y: 0 })]);
  const crossing = reachableTiles(map, { x: 0, y: 0 }, 3, new Set(), ally).map(key);
  expect(crossing).toContain("2,0");
  expect(crossing).not.toContain("1,0");
  expect(reachableTiles(map, { x: 0, y: 0 }, 3, enemy, new Set()).map(key)).toEqual([]);
});

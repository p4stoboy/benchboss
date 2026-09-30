import { type GameMap, NEIGHBOURS, inBounds, key, stepCost } from "./map";
import type { Point } from "./types";

export interface Reach {
  x: number;
  y: number;
  cost: number;
  /** Tiles from the first step to this tile, exclusive of the origin. */
  path: Point[];
}

/**
 * Deterministic Dijkstra within `budget` move points over `visible` tiles only. `blocked` tiles
 * cannot be entered; `passable` tiles can be crossed but not ended on (allies). The origin is
 * never returned.
 */
export function reachableTiles(
  map: GameMap,
  origin: Point,
  budget: number,
  blocked: ReadonlySet<string>,
  passable: ReadonlySet<string>,
  visible: ReadonlySet<string>,
): Reach[] {
  const best = new Map<string, Reach>();
  const frontier: Reach[] = [{ ...origin, cost: 0, path: [] }];
  best.set(key(origin), frontier[0] as Reach);
  while (frontier.length) {
    // Lowest cost first; ties keep insertion order so paths are canonical.
    let index = 0;
    for (let i = 1; i < frontier.length; i++)
      if ((frontier[i] as Reach).cost < (frontier[index] as Reach).cost) index = i;
    const current = frontier.splice(index, 1)[0] as Reach;
    if (current.cost > (best.get(key(current))?.cost ?? Number.POSITIVE_INFINITY)) continue;
    for (const d of NEIGHBOURS) {
      const next = { x: current.x + d.x, y: current.y + d.y };
      if (!inBounds(map, next) || !visible.has(key(next)) || blocked.has(key(next))) continue;
      const step = stepCost(map, current, next);
      if (step === null) continue;
      const cost = current.cost + step;
      if (cost > budget) continue;
      const known = best.get(key(next));
      if (known && known.cost <= cost) continue;
      const reach = { ...next, cost, path: [...current.path, next] };
      best.set(key(next), reach);
      frontier.push(reach);
    }
  }
  best.delete(key(origin));
  return [...best.values()].filter((r) => !passable.has(key(r)));
}

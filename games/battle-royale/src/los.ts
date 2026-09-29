import { type GameMap, chebyshev, tileAt } from "./map";
import type { Point } from "./types";

// Heights are doubled so an eye sits at h + 0.5 without fractions. A tile between
// the endpoints blocks when it is a wall or its surface rises above the sight line.
function clearOneWay(map: GameMap, a: Point, b: Point): boolean {
  const steps = chebyshev(a, b);
  if (steps <= 1) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const za = 2 * tileAt(map, a).h + 1;
  const zb = 2 * tileAt(map, b).h + 1;
  for (let i = 1; i < steps; i++) {
    const cell = {
      x: a.x + Math.round((dx * i) / steps),
      y: a.y + Math.round((dy * i) / steps),
    };
    const tile = tileAt(map, cell);
    if (tile.kind === "wall") return false;
    // Compare surface height against the line height at this step, both scaled by `steps`.
    if (2 * tile.h * steps > za * steps + (zb - za) * i) return false;
  }
  return true;
}

/** Symmetric by construction: both directions must be clear. */
export const hasLineOfSight = (map: GameMap, a: Point, b: Point): boolean =>
  clearOneWay(map, a, b) && clearOneWay(map, b, a);

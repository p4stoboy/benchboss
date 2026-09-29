import type { SeatId } from "@benchboss/core";
import { CLASSES } from "./classes";
import { hasLineOfSight } from "./los";
import { type GameMap, inBounds, key, tileAt } from "./map";
import type { Point, Unit } from "./types";

export const visionRadius = (map: GameMap, unit: Unit): number =>
  CLASSES[unit.cls].vision + tileAt(map, unit).h;

/** Keys of every tile at least one living unit of `seat` can see. */
export function visibleTiles(map: GameMap, units: readonly Unit[], seat: SeatId): Set<string> {
  const seen = new Set<string>();
  for (const unit of units) {
    if (unit.seat !== seat || !unit.alive) continue;
    const radius = visionRadius(map, unit);
    for (let y = unit.y - radius; y <= unit.y + radius; y++)
      for (let x = unit.x - radius; x <= unit.x + radius; x++) {
        const p: Point = { x, y };
        if (!inBounds(map, p) || seen.has(key(p))) continue;
        if (hasLineOfSight(map, unit, p)) seen.add(key(p));
      }
  }
  return seen;
}

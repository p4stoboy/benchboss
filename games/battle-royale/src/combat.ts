import { CLASSES } from "./classes";
import { hasLineOfSight } from "./los";
import { type GameMap, chebyshev, tileAt } from "./map";
import type { Point, Unit } from "./types";

/** Effective Chebyshev range from `from`: ranged classes gain one tile when firing downhill. */
export function attackRange(map: GameMap, from: Point, cls: Unit["cls"], target: Point): number {
  const base = CLASSES[cls].range;
  return base >= 2 && tileAt(map, from).h > tileAt(map, target).h ? base + 1 : base;
}

export function attackBlocker(
  map: GameMap,
  from: Point,
  cls: Unit["cls"],
  target: Point,
): string | null {
  if (chebyshev(from, target) > attackRange(map, from, cls, target)) return "out of range";
  if (!hasLineOfSight(map, from, target)) return "no line of sight";
  return null;
}

/** Height advantage adds one, disadvantage removes one, cover removes one; never below one. */
export function damageFor(map: GameMap, from: Point, cls: Unit["cls"], target: Point): number {
  const dh = tileAt(map, from).h - tileAt(map, target).h;
  const height = dh > 0 ? 1 : dh < 0 ? -1 : 0;
  const cover = tileAt(map, target).kind === "cover" ? 1 : 0;
  return Math.max(1, CLASSES[cls].damage + height - cover);
}

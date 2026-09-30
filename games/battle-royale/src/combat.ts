import { WEAPONS, type WeaponId } from "./classes";
import { type Known, hasLineOfSight } from "./los";
import { type GameMap, chebyshev, tileAt } from "./map";
import type { Point } from "./types";

/** Effective Chebyshev range from `from`: ranged weapons gain one tile when firing downhill. */
export function attackRange(map: GameMap, from: Point, weapon: WeaponId, target: Point): number {
  const base = WEAPONS[weapon].range;
  return base >= 2 && tileAt(map, from).h > tileAt(map, target).h ? base + 1 : base;
}

/** Why an attack from `from` cannot land, or null. `known` limits the sight check to seen tiles. */
export function attackBlocker(
  map: GameMap,
  from: Point,
  weapon: WeaponId,
  target: Point,
  known?: Known,
): string | null {
  if (chebyshev(from, target) > attackRange(map, from, weapon, target)) return "out of range";
  if (!hasLineOfSight(map, from, target, known)) return "no line of sight";
  return null;
}

/** Height advantage adds one, disadvantage removes one, cover removes one; never below one. */
export function damageFor(map: GameMap, from: Point, weapon: WeaponId, target: Point): number {
  const dh = tileAt(map, from).h - tileAt(map, target).h;
  const height = dh > 0 ? 1 : dh < 0 ? -1 : 0;
  const cover = tileAt(map, target).kind === "cover" ? 1 : 0;
  return Math.max(1, WEAPONS[weapon].damage + height - cover);
}

import type { Rng } from "@benchboss/core";
import type { WeaponId } from "./classes";
import { type GameMap, chebyshev, key } from "./map";
import type { Item, Point } from "./types";

/** One item is scattered per this many map tiles, candidates permitting. */
export const LOOT_TILES_PER_ITEM = 30;
/** Loot never lies closer than this to any spawn tile, so nothing is free at spawn. */
export const LOOT_SPAWN_GAP = 3;

const ITEM_WEIGHTS: readonly (readonly [Item["kind"], number])[] = [
  ["health", 4],
  ["armour", 3],
  ["weapon", 3],
];
const WEAPON_WEIGHTS: readonly (readonly [WeaponId, number])[] = [
  ["shotgun", 3],
  ["autorifle", 3],
  ["marksman", 3],
  ["railgun", 1],
];

function weighted<T>(rng: Rng, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.int(total);
  for (const [value, weight] of table) {
    if (roll < weight) return value;
    roll -= weight;
  }
  return (table[table.length - 1] as readonly [T, number])[0];
}

/** Seeded loot over non-wall tiles at least LOOT_SPAWN_GAP from every spawn tile. */
export function scatterLoot(rng: Rng, map: GameMap): Item[] {
  const spawnTiles = map.spawns.flat();
  const candidates: Point[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const p = { x, y };
      if (map.tiles[y]?.[x]?.kind === "wall") continue;
      if (spawnTiles.some((s) => chebyshev(s, p) < LOOT_SPAWN_GAP)) continue;
      candidates.push(p);
    }
  const count = Math.min(
    candidates.length,
    Math.floor((map.width * map.height) / LOOT_TILES_PER_ITEM),
  );
  return rng
    .shuffle(candidates)
    .slice(0, count)
    .map(({ x, y }): Item => {
      const kind = weighted(rng, ITEM_WEIGHTS);
      return kind === "weapon"
        ? { x, y, kind, weapon: weighted(rng, WEAPON_WEIGHTS) }
        : { x, y, kind };
    });
}

export const itemAt = (items: readonly Item[], p: Point): Item | undefined =>
  items.find((item) => key(item) === key(p));

export const itemLabel = (item: Item): string =>
  item.kind === "weapon" ? `weapon:${item.weapon}` : item.kind;

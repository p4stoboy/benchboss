import type { Rng } from "@benchboss/core";
import { CLASSES } from "./classes";
import { hasLineOfSight } from "./los";
import {
  type GameMap,
  MAX_HEIGHT,
  NEIGHBOURS,
  type Tile,
  chebyshev,
  inBounds,
  key,
  mapSize,
  stepCost,
  tileAt,
  zoneCenter,
} from "./map";
import type { Point } from "./types";

const WALL_CHANCE = 0.06;
const COVER_CHANCE = 0.08;
const NOISE_CELL = 3;
const GENERATION_ATTEMPTS = 24;
/** An attempt with fewer non-open tiles than this share of the map is rejected as featureless. */
const MIN_FEATURE_SHARE = 0.05;
/** Hidden is not enough on its own: teams also start at least this many tiles apart. */
export const MIN_SPAWN_GAP = 4;
/** The farthest any unit could see from spawn: the best class vision from the highest tile. */
export const MAX_SPAWN_VISION =
  Math.max(...Object.values(CLASSES).map((c) => c.vision)) + MAX_HEIGHT;

function noiseHeights(rng: Rng, width: number, height: number): number[][] {
  const cols = Math.ceil(width / NOISE_CELL) + 1;
  const rows = Math.ceil(height / NOISE_CELL) + 1;
  const lattice = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => rng.int(MAX_HEIGHT + 1)),
  );
  const at = (r: number, c: number): number => lattice[r]?.[c] ?? 0;
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const gx = x / NOISE_CELL;
      const gy = y / NOISE_CELL;
      const c = Math.floor(gx);
      const r = Math.floor(gy);
      const fx = gx - c;
      const fy = gy - r;
      const top = at(r, c) * (1 - fx) + at(r, c + 1) * fx;
      const bottom = at(r + 1, c) * (1 - fx) + at(r + 1, c + 1) * fx;
      return Math.min(MAX_HEIGHT, Math.max(0, Math.round(top * (1 - fy) + bottom * fy)));
    }),
  );
}

/** Every tile within spawn vision of `origin` that has line of sight to it. */
function exposedBy(map: GameMap, origin: Point): Point[] {
  const tiles: Point[] = [];
  for (let dy = -MAX_SPAWN_VISION; dy <= MAX_SPAWN_VISION; dy++)
    for (let dx = -MAX_SPAWN_VISION; dx <= MAX_SPAWN_VISION; dx++) {
      const p = { x: origin.x + dx, y: origin.y + dy };
      if (inBounds(map, p) && hasLineOfSight(map, origin, p)) tiles.push(p);
    }
  return tiles;
}

/** Claims `count` free, non-wall tiles nearest `origin` by breadth-first order. */
function claimCluster(map: GameMap, origin: Point, count: number, taken: Set<string>): Point[] {
  const claimed: Point[] = [];
  const seen = new Set<string>([key(origin)]);
  const queue: Point[] = [origin];
  while (queue.length && claimed.length < count) {
    const current = queue.shift() as Point;
    if (!taken.has(key(current))) {
      if (tileAt(map, current).kind === "wall") tileAt(map, current).kind = "open";
      claimed.push(current);
      taken.add(key(current));
    }
    for (const d of NEIGHBOURS) {
      const next = { x: current.x + d.x, y: current.y + d.y };
      if (inBounds(map, next) && !seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  if (claimed.length < count) throw Error("map too small for spawn clusters");
  return claimed;
}

/**
 * Farthest-point placement outside every placed team's sight. The first origin is a seeded pick
 * from the outer ring; each next origin is the tile (with its neighbours, so the cluster fits)
 * that no placed spawn tile can see, farthest from all placed origins, ties farther from centre
 * then row-major. Throws when no such tile remains, failing the attempt.
 */
function placeSpawns(rng: Rng, map: GameMap, teams: number, teamSize: number): Point[][] {
  const centre = zoneCenter(map);
  const half = Math.max(map.width, map.height) / 2;
  const open: Point[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (tileAt(map, { x, y }).kind !== "wall") open.push({ x, y });
  const outer = open.filter((p) => chebyshev(p, centre) >= Math.floor(half * 0.8));
  const taken = new Set<string>();
  const exposed = new Set<string>();
  const origins: Point[] = [];
  const spawns: Point[][] = [];
  const settle = (origin: Point): void => {
    const cluster = claimCluster(map, origin, teamSize, taken);
    for (const tile of cluster) for (const seen of exposedBy(map, tile)) exposed.add(key(seen));
    origins.push(origin);
    spawns.push(cluster);
  };
  const fits = (p: Point): boolean =>
    !exposed.has(key(p)) &&
    !taken.has(key(p)) &&
    NEIGHBOURS.every((d) => {
      const n = { x: p.x + d.x, y: p.y + d.y };
      return !inBounds(map, n) || (!exposed.has(key(n)) && !taken.has(key(n)));
    });
  settle(rng.pick(outer.length ? outer : open));
  while (spawns.length < teams) {
    let best: Point | null = null;
    let bestGap = -1;
    let bestEdge = -1;
    for (const p of open) {
      if (!fits(p)) continue;
      const gap = Math.min(...origins.map((o) => chebyshev(o, p)));
      if (gap < MIN_SPAWN_GAP + 2) continue;
      const edge = chebyshev(p, centre);
      if (gap > bestGap || (gap === bestGap && edge > bestEdge)) {
        best = p;
        bestGap = gap;
        bestEdge = edge;
      }
    }
    if (!best) throw Error("no hidden spawn left");
    settle(best);
  }
  return spawns;
}

function allSpawnsConnected(map: GameMap): boolean {
  const targets = new Set(map.spawns.flat().map(key));
  const start = map.spawns[0]?.[0];
  if (!start) return false;
  const seen = new Set<string>([key(start)]);
  const queue: Point[] = [start];
  while (queue.length) {
    const current = queue.shift() as Point;
    targets.delete(key(current));
    for (const d of NEIGHBOURS) {
      const next = { x: current.x + d.x, y: current.y + d.y };
      if (stepCost(map, current, next) !== null && !seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return targets.size === 0;
}

/** Smallest Chebyshev distance between any two spawn tiles of different teams. */
export function spawnGap(map: GameMap): number {
  let gap = Number.POSITIVE_INFINITY;
  map.spawns.forEach((team, i) => {
    for (const other of map.spawns.slice(i + 1))
      for (const a of team) for (const b of other) gap = Math.min(gap, chebyshev(a, b));
  });
  return gap;
}

/** True when no spawn tile can see a spawn tile of another team, whatever class stands there. */
export function spawnsHidden(map: GameMap): boolean {
  return map.spawns.every((team, i) =>
    map.spawns
      .slice(i + 1)
      .every((other) =>
        team.every((a) =>
          other.every((b) => chebyshev(a, b) > MAX_SPAWN_VISION || !hasLineOfSight(map, a, b)),
        ),
      ),
  );
}

const hasFeatures = (map: GameMap): boolean =>
  map.tiles.flat().filter((t) => t.kind !== "open").length >=
  Math.ceil(map.width * map.height * MIN_FEATURE_SHARE);

function attempt(
  rng: Rng,
  width: number,
  height: number,
  teams: number,
  teamSize: number,
  flat: boolean,
): GameMap {
  const heights = flat
    ? Array.from({ length: height }, () => Array.from({ length: width }, () => 0))
    : noiseHeights(rng.fork("heights"), width, height);
  const scatter = rng.fork("scatter");
  const tiles = heights.map((row) =>
    row.map((h): Tile => {
      const roll = flat ? 1 : scatter.nextFloat();
      return {
        h,
        kind: roll < WALL_CHANCE ? "wall" : roll < WALL_CHANCE + COVER_CHANCE ? "cover" : "open",
      };
    }),
  );
  const map: GameMap = { width, height, tiles, spawns: [] };
  map.spawns = placeSpawns(rng.fork("origins"), map, teams, teamSize);
  return map;
}

/**
 * Seeded map: up to 24 noise attempts, each accepted only when spawns are mutually reachable,
 * hidden from every other team, at least MIN_SPAWN_GAP apart and the map has terrain features.
 * A flat open map is the last resort for areas too small for that; it only spreads spawns.
 */
export function generateMap(
  rng: Rng,
  seats: number,
  tilesPerSeat: number,
  teamSize: number,
): GameMap {
  const { width, height } = mapSize(seats, tilesPerSeat);
  for (let i = 0; i < GENERATION_ATTEMPTS; i++) {
    try {
      const map = attempt(rng.fork(`attempt:${i}`), width, height, seats, teamSize, false);
      if (
        allSpawnsConnected(map) &&
        hasFeatures(map) &&
        spawnsHidden(map) &&
        spawnGap(map) >= MIN_SPAWN_GAP
      )
        return map;
    } catch {
      // Placement ran out of hidden tiles; try the next seeded attempt.
    }
  }
  const map = attemptFlat(rng.fork("flat"), width, height, seats, teamSize);
  if (!allSpawnsConnected(map)) throw Error("flat map is not connected");
  return map;
}

/** Flat fallback: farthest-point placement without the hidden constraint. */
function attemptFlat(
  rng: Rng,
  width: number,
  height: number,
  teams: number,
  teamSize: number,
): GameMap {
  try {
    return attempt(rng, width, height, teams, teamSize, true);
  } catch {
    const tiles = Array.from({ length: height }, () =>
      Array.from({ length: width }, (): Tile => ({ h: 0, kind: "open" })),
    );
    const map: GameMap = { width, height, tiles, spawns: [] };
    const centre = zoneCenter(map);
    const taken = new Set<string>();
    const origins: Point[] = [];
    while (map.spawns.length < teams) {
      let best: Point | null = null;
      let bestGap = -1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const p = { x, y };
          if (taken.has(key(p))) continue;
          const gap = origins.length
            ? Math.min(...origins.map((o) => chebyshev(o, p)))
            : chebyshev(p, centre);
          if (gap > bestGap) {
            best = p;
            bestGap = gap;
          }
        }
      if (!best) throw Error("map too small for spawn clusters");
      origins.push(best);
      map.spawns.push(claimCluster(map, best, teamSize, taken));
    }
    void rng;
    return map;
  }
}

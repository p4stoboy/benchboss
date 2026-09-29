import type { Rng } from "@benchboss/core";
import type { Point } from "./types";

export type TileKind = "open" | "wall" | "cover";
export interface Tile {
  h: number;
  kind: TileKind;
}
export interface GameMap {
  width: number;
  height: number;
  /** Row-major: tiles[y][x]. */
  tiles: Tile[][];
  /** One entry per seat index, in seat order; each holds TEAM_SIZE distinct spawn tiles. */
  spawns: Point[][];
}

export const MAX_HEIGHT = 3;
const WALL_CHANCE = 0.06;
const COVER_CHANCE = 0.08;
const NOISE_CELL = 3;
const GENERATION_ATTEMPTS = 24;
/** An attempt with fewer non-open tiles than this share of the map is rejected as featureless. */
const MIN_FEATURE_SHARE = 0.05;

export const key = (p: Point): string => `${p.x},${p.y}`;
export const chebyshev = (a: Point, b: Point): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function mapSize(seats: number, tilesPerSeat: number): { width: number; height: number } {
  const area = seats * tilesPerSeat;
  const width = Math.ceil(Math.sqrt(area));
  const height = Math.ceil(area / width);
  return { width, height };
}

export const inBounds = (map: GameMap, p: Point): boolean =>
  Number.isInteger(p.x) &&
  Number.isInteger(p.y) &&
  p.x >= 0 &&
  p.y >= 0 &&
  p.x < map.width &&
  p.y < map.height;

export function tileAt(map: GameMap, p: Point): Tile {
  const tile = map.tiles[p.y]?.[p.x];
  if (!tile) throw Error(`tile out of bounds: ${key(p)}`);
  return tile;
}

/** Movement cost of one step between adjacent tiles, or null when impassable. */
export function stepCost(map: GameMap, from: Point, to: Point): number | null {
  if (!inBounds(map, to) || chebyshev(from, to) !== 1) return null;
  const target = tileAt(map, to);
  if (target.kind === "wall") return null;
  const climb = target.h - tileAt(map, from).h;
  if (Math.abs(climb) > 1) return null;
  return climb > 0 ? 2 : 1;
}

export const NEIGHBOURS: readonly Point[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

export const zoneCenter = (map: GameMap): Point => ({
  x: Math.floor((map.width - 1) / 2),
  y: Math.floor((map.height - 1) / 2),
});

export const closeRound = (maxRounds: number): number =>
  Math.max(1, Math.floor((maxRounds * 3) / 4));

/** Chebyshev half-size of the safe square for a round; 0 leaves only the centre tile safe. */
export function zoneRadius(map: GameMap, maxRounds: number, round: number): number {
  const close = closeRound(maxRounds);
  if (round >= close) return 0;
  const full = Math.max(map.width, map.height);
  return Math.ceil((full * (close - round)) / close);
}

export const stormDamage = (round: number): number => 1 + Math.floor(round / 10);

export const inZone = (map: GameMap, maxRounds: number, round: number, p: Point): boolean =>
  chebyshev(zoneCenter(map), p) <= zoneRadius(map, maxRounds, round);

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

/**
 * Farthest-point placement: the first origin is a seeded pick from the map's outer ring, each
 * further origin is the non-wall tile farthest from every origin so far (ties: farther from
 * centre, then row-major). Teams therefore start as far apart as the map allows at any count.
 */
function spawnOrigins(rng: Rng, map: GameMap, teams: number): Point[] {
  const centre = zoneCenter(map);
  const half = Math.max(map.width, map.height) / 2;
  const candidates: Point[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (tileAt(map, { x, y }).kind !== "wall") candidates.push({ x, y });
  const outer = candidates.filter((p) => chebyshev(p, centre) >= Math.floor(half * 0.8));
  const origins: Point[] = [rng.pick(outer.length ? outer : candidates)];
  while (origins.length < teams) {
    let best: Point | null = null;
    let bestGap = -1;
    let bestEdge = -1;
    for (const p of candidates) {
      const gap = Math.min(...origins.map((o) => chebyshev(o, p)));
      const edge = chebyshev(p, centre);
      if (gap > bestGap || (gap === bestGap && edge > bestEdge)) {
        best = p;
        bestGap = gap;
        bestEdge = edge;
      }
    }
    if (!best || bestGap < 1) throw Error("map too small for spawn origins");
    origins.push(best);
  }
  return origins;
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

/**
 * Spawn separation a generated attempt must reach. Farthest-point placement usually does far
 * better; this only rejects attempts where walls or packing squeezed two teams together.
 */
export const requiredSpawnGap = (tilesPerSeat: number): number =>
  Math.max(1, Math.floor(Math.sqrt(tilesPerSeat) / 2));

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
  const taken = new Set<string>();
  map.spawns = spawnOrigins(rng.fork("origins"), map, teams).map((origin) =>
    claimCluster(map, origin, teamSize, taken),
  );
  return map;
}

const hasFeatures = (map: GameMap): boolean =>
  map.tiles.flat().filter((t) => t.kind !== "open").length >=
  Math.ceil(map.width * map.height * MIN_FEATURE_SHARE);

export function generateMap(
  rng: Rng,
  seats: number,
  tilesPerSeat: number,
  teamSize: number,
): GameMap {
  const { width, height } = mapSize(seats, tilesPerSeat);
  const gap = requiredSpawnGap(tilesPerSeat);
  for (let i = 0; i < GENERATION_ATTEMPTS; i++) {
    const map = attempt(rng.fork(`attempt:${i}`), width, height, seats, teamSize, false);
    if (allSpawnsConnected(map) && hasFeatures(map) && spawnGap(map) >= gap) return map;
  }
  const map = attempt(rng.fork("flat"), width, height, seats, teamSize, true);
  if (!allSpawnsConnected(map)) throw Error("flat map is not connected");
  return map;
}

/** Row-major copies: grid[y][x]. */
export const heightGrid = (map: GameMap): number[][] => map.tiles.map((row) => row.map((t) => t.h));
export const terrainGrid = (map: GameMap): TileKind[][] =>
  map.tiles.map((row) => row.map((t) => t.kind));

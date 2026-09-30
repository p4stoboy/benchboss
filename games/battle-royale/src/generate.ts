import type { Rng } from "@benchboss/core";
import { CLASSES } from "./classes";
import { hasLineOfSight } from "./los";
import {
  BASE_HEIGHT,
  type GameMap,
  MAX_HEIGHT,
  NEIGHBOURS,
  type Tile,
  chebyshev,
  inBounds,
  key,
  mapCenter,
  mapSize,
  stepCost,
  tileAt,
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
const BEST_VISION = Math.max(...Object.values(CLASSES).map((c) => c.vision));
/** The farthest any unit could see from spawn: the best class vision from the highest tile. */
export const MAX_SPAWN_VISION = BEST_VISION + MAX_HEIGHT;
/** One plateau per this many tiles of map area, at least one. */
const TILES_PER_PLATEAU = 400;
const PLATEAU_MIN_SIZE = 12;
const PLATEAU_MAX_SIZE = 40;
const PLATEAU_MIN_RAISE = 2;
const PLATEAU_MAX_RAISE = 3;
/** One ramp per plateau plus one per this many plateau tiles. */
const PLATEAU_TILES_PER_RAMP = 16;
/** Repair passes over stranded regions before an attempt is judged. */
const REPAIR_LIMIT = 24;
/** A stranded region this small is flattened to its neighbour's level, or walled when sealed. */
const SMALL_REGION_MAX = 8;
const ORTHOGONAL: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function noiseHeights(rng: Rng, width: number, height: number): number[][] {
  const cols = Math.ceil(width / NOISE_CELL) + 1;
  const rows = Math.ceil(height / NOISE_CELL) + 1;
  const lattice = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => rng.int(BASE_HEIGHT + 1)),
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
      return Math.min(BASE_HEIGHT, Math.max(0, Math.round(top * (1 - fy) + bottom * fy)));
    }),
  );
}

/**
 * A 4-way grown blob of `size` tiles from `origin`, raised by `raise` levels (clamped). Returns
 * the blob's tile keys so ramps can be carved against it.
 */
function raisePlateau(
  rng: Rng,
  map: GameMap,
  origin: Point,
  size: number,
  raise: number,
): Set<string> {
  const blob = new Set<string>([key(origin)]);
  let frontier: Point[] = [origin];
  while (blob.size < size && frontier.length) {
    const index = rng.int(frontier.length);
    const current = frontier[index] as Point;
    frontier = [...frontier.slice(0, index), ...frontier.slice(index + 1)];
    for (const d of ORTHOGONAL) {
      const next = { x: current.x + d.x, y: current.y + d.y };
      if (!inBounds(map, next) || blob.has(key(next)) || blob.size >= size) continue;
      blob.add(key(next));
      frontier.push(next);
    }
  }
  for (const tile of blob) {
    const [x, y] = tile.split(",").map(Number) as [number, number];
    const t = tileAt(map, { x, y });
    t.h = Math.min(MAX_HEIGHT, t.h + raise);
  }
  return blob;
}

type Inside = (p: Point) => boolean;

/**
 * Carves a staircase from the walkable tile just outside `border` inward along `dir`: tile k gets
 * the outside height + k and is forced open, until the next inside tile is within one level.
 * False when the outside tile is missing, inside or a wall, or the stair leaves the region or
 * the map.
 */
function carveStair(map: GameMap, inside: Inside, border: Point, dir: Point): boolean {
  const outside = { x: border.x - dir.x, y: border.y - dir.y };
  if (!inBounds(map, outside) || inside(outside) || tileAt(map, outside).kind === "wall")
    return false;
  const base = tileAt(map, outside).h;
  const stair: Point[] = [];
  let p = border;
  for (let k = 1; ; k++) {
    if (!inBounds(map, p) || !inside(p)) return false;
    if (tileAt(map, p).h <= base + k) break;
    stair.push(p);
    p = { x: p.x + dir.x, y: p.y + dir.y };
  }
  stair.forEach((tile, i) => {
    const t = tileAt(map, tile);
    t.h = base + i + 1;
    t.kind = "open";
  });
  return true;
}

/** Tries seeded border tiles until `count` ramps are carved or every candidate failed. */
function carveRamps(rng: Rng, map: GameMap, blob: Set<string>, count: number): void {
  const candidates: { border: Point; dir: Point }[] = [];
  for (const tile of blob) {
    const [x, y] = tile.split(",").map(Number) as [number, number];
    for (const dir of ORTHOGONAL) {
      const outside = { x: x - dir.x, y: y - dir.y };
      if (inBounds(map, outside) && !blob.has(key(outside)))
        candidates.push({ border: { x, y }, dir });
    }
  }
  let carved = 0;
  while (carved < count && candidates.length) {
    const index = rng.int(candidates.length);
    const [candidate] = candidates.splice(index, 1) as [{ border: Point; dir: Point }];
    if (carveStair(map, (p) => blob.has(key(p)), candidate.border, candidate.dir)) carved++;
  }
}

function raisePlateaus(rng: Rng, map: GameMap): void {
  const count = Math.max(1, Math.round((map.width * map.height) / TILES_PER_PLATEAU));
  for (let i = 0; i < count; i++) {
    const origin = { x: rng.int(map.width), y: rng.int(map.height) };
    const size = PLATEAU_MIN_SIZE + rng.int(PLATEAU_MAX_SIZE - PLATEAU_MIN_SIZE + 1);
    const raise = PLATEAU_MIN_RAISE + rng.int(PLATEAU_MAX_RAISE - PLATEAU_MIN_RAISE + 1);
    const blob = raisePlateau(rng, map, origin, size, raise);
    carveRamps(rng, map, blob, 1 + Math.floor(blob.size / PLATEAU_TILES_PER_RAMP));
  }
}

/** Component id per walkable tile key, with each component's size. */
function components(map: GameMap): { of: Map<string, number>; sizes: number[] } {
  const of = new Map<string, number>();
  const sizes: number[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const start = { x, y };
      if (tileAt(map, start).kind === "wall" || of.has(key(start))) continue;
      const id = sizes.length;
      of.set(key(start), id);
      const queue: Point[] = [start];
      let size = 0;
      while (queue.length) {
        const current = queue.pop() as Point;
        size++;
        for (const d of NEIGHBOURS) {
          const next = { x: current.x + d.x, y: current.y + d.y };
          if (stepCost(map, current, next) !== null && !of.has(key(next))) {
            of.set(key(next), id);
            queue.push(next);
          }
        }
      }
      sizes.push(size);
    }
  return { of, sizes };
}

/**
 * Reconnects stranded regions. Each pass carves one stair per component other than the largest,
 * across its gentlest cliff edge (into it when it stands higher, out of it when lower), then
 * recomputes. A small region no stair fits is flattened to one level off that neighbour; a
 * small region sealed by walls becomes wall; anything left over fails the attempt's
 * connectivity check.
 */
function repairConnectivity(map: GameMap): void {
  for (let pass = 0; pass < REPAIR_LIMIT; pass++) {
    const { of, sizes } = components(map);
    if (sizes.length <= 1) return;
    const largest = sizes.indexOf(Math.max(...sizes));
    const edges = new Map<number, { u: Point; v: Point; dir: Point; delta: number }[]>();
    for (const [tile, id] of of) {
      if (id === largest) continue;
      const [x, y] = tile.split(",").map(Number) as [number, number];
      const u = { x, y };
      for (const dir of NEIGHBOURS) {
        const v = { x: x + dir.x, y: y + dir.y };
        if (!inBounds(map, v) || tileAt(map, v).kind === "wall" || of.get(key(v)) === id) continue;
        const list = edges.get(id) ?? [];
        list.push({ u, v, dir, delta: tileAt(map, u).h - tileAt(map, v).h });
        edges.set(id, list);
      }
    }
    let progress = false;
    for (let id = 0; id < sizes.length; id++) {
      if (id === largest) continue;
      const list = (edges.get(id) ?? []).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      const inRegion: Inside = (p) => of.get(key(p)) === id;
      let carved = false;
      for (const edge of list) {
        // `dir` runs u → v. A higher region is climbed from v into u; a lower one from u into v.
        const inTarget: Inside = (p) => of.get(key(p)) === of.get(key(edge.v));
        carved =
          edge.delta >= 0
            ? carveStair(map, inRegion, edge.u, { x: -edge.dir.x, y: -edge.dir.y })
            : carveStair(map, inTarget, edge.v, edge.dir);
        if (carved) break;
      }
      if (carved) {
        progress = true;
        continue;
      }
      if ((sizes[id] ?? 0) > SMALL_REGION_MAX) continue;
      const gentlest = list[0];
      const level =
        gentlest &&
        Math.min(
          MAX_HEIGHT,
          Math.max(0, tileAt(map, gentlest.v).h + (gentlest.delta > 0 ? 1 : -1)),
        );
      for (const [tile, owner] of of) {
        if (owner !== id) continue;
        const [x, y] = tile.split(",").map(Number) as [number, number];
        const t = tileAt(map, { x, y });
        if (level === undefined) t.kind = "wall";
        else t.h = level;
      }
      progress = true;
    }
    if (!progress) return;
  }
}

/** The best class on either tile sees the other: within its vision plus its height, in sight. */
const inSpawnSight = (map: GameMap, a: Point, b: Point): boolean =>
  chebyshev(a, b) <= BEST_VISION + Math.max(tileAt(map, a).h, tileAt(map, b).h) &&
  hasLineOfSight(map, a, b);

/** Every tile a unit on `origin` could see, or that could see `origin`. */
function exposedBy(map: GameMap, origin: Point): Point[] {
  const tiles: Point[] = [];
  for (let dy = -MAX_SPAWN_VISION; dy <= MAX_SPAWN_VISION; dy++)
    for (let dx = -MAX_SPAWN_VISION; dx <= MAX_SPAWN_VISION; dx++) {
      const p = { x: origin.x + dx, y: origin.y + dy };
      if (inBounds(map, p) && inSpawnSight(map, origin, p)) tiles.push(p);
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
  const centre = mapCenter(map);
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

/** True when every non-wall tile is reachable from the first spawn over passable steps. */
export function allTilesConnected(map: GameMap): boolean {
  const start = map.spawns[0]?.[0];
  if (!start) return false;
  const seen = new Set<string>([key(start)]);
  const queue: Point[] = [start];
  while (queue.length) {
    const current = queue.shift() as Point;
    for (const d of NEIGHBOURS) {
      const next = { x: current.x + d.x, y: current.y + d.y };
      if (stepCost(map, current, next) !== null && !seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return map.tiles.every((row, y) =>
    row.every((tile, x) => tile.kind === "wall" || seen.has(key({ x, y }))),
  );
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
      .every((other) => team.every((a) => other.every((b) => !inSpawnSight(map, a, b)))),
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
  if (!flat) {
    raisePlateaus(rng.fork("plateaus"), map);
    repairConnectivity(map);
  }
  map.spawns = placeSpawns(rng.fork("origins"), map, teams, teamSize);
  return map;
}

/**
 * Seeded map: up to 24 noise attempts, each accepted only when every non-wall tile is reachable,
 * spawns are hidden from every other team, at least MIN_SPAWN_GAP apart and the map has terrain
 * features. A flat open map is the last resort for areas too small for that; it only spreads
 * spawns.
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
        allTilesConnected(map) &&
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
  if (!allTilesConnected(map)) throw Error("flat map is not connected");
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
    const centre = mapCenter(map);
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

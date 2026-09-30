import type { Point } from "./types";

/** Public-frame legend order: a new kind is appended, never inserted. */
export const TILE_KINDS = ["open", "cover", "wall"] as const;
export type TileKind = (typeof TILE_KINDS)[number];
export interface Tile {
  h: number;
  kind: TileKind;
}

/**
 * One integer per tile for public frames: `h * kinds + kindIndex`, where `kinds` is the length
 * of the legend list the same frame carries. Decoding needs nothing but that list.
 */
export const tileCode = (tile: Tile): number =>
  tile.h * TILE_KINDS.length + TILE_KINDS.indexOf(tile.kind);
export interface GameMap {
  width: number;
  height: number;
  /** Row-major: tiles[y][x]. */
  tiles: Tile[][];
  /** One entry per seat index, in seat order; each holds TEAM_SIZE distinct spawn tiles. */
  spawns: Point[][];
}

/** Rolling ground from noise reaches this height; plateaus rise above it. */
export const BASE_HEIGHT = 3;
export const MAX_HEIGHT = 6;

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

export const mapCenter = (map: GameMap): Point => ({
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

/** Row-major copies: grid[y][x]. */

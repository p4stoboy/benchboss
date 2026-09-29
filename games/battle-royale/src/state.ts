import type { SeatId } from "@benchboss/core";
import { CLASSES } from "./classes";
import { attackBlocker } from "./combat";
import { key } from "./map";
import { type Reach, reachableTiles } from "./path";
import type { BrState, Point, SeenUnit, Unit } from "./types";
import { visibleTiles } from "./vision";

export const unitById = (state: BrState, id: string): Unit | undefined =>
  state.units.find((u) => u.id === id);
export const ownUnits = (state: BrState, seat: SeatId): Unit[] =>
  state.units.filter((u) => u.seat === seat && u.alive);
export const isEliminated = (state: BrState, seat: SeatId): boolean =>
  state.teams[seat]?.placement !== null;
export const aliveSeats = (state: BrState): SeatId[] =>
  state.seats.filter((seat) => !isEliminated(state, seat));
export const maxHp = (unit: Unit): number => CLASSES[unit.cls].hp;

/** Seats rotate through first initiative each round; eliminated seats are skipped. */
export function initiative(state: BrState): SeatId[] {
  const n = state.seats.length;
  const start = (state.round - 1) % n;
  const rotated = [...state.seats.slice(start), ...state.seats.slice(0, start)];
  return rotated.filter((seat) => !isEliminated(state, seat));
}

export const visionOf = (state: BrState, seat: SeatId): Set<string> =>
  visibleTiles(state.map, state.units, seat);

export function visibleEnemies(state: BrState, seat: SeatId, seen = visionOf(state, seat)): Unit[] {
  return state.units.filter((u) => u.alive && u.seat !== seat && seen.has(key(u)));
}

export interface UnitPlan {
  unit: Unit;
  reaches: (Reach & { targets: string[] })[];
}

// States are immutable values, so planning for one state object is memoised per seat: the
// referee computes a safe default and then submits it against the same state object.
const PLAN_CACHE = new WeakMap<BrState, Map<SeatId, UnitPlan[]>>();

/** Everything a seat may legally order this round, computed from its own knowledge only. */
export function plans(state: BrState, seat: SeatId): UnitPlan[] {
  let bySeat = PLAN_CACHE.get(state);
  if (!bySeat) {
    bySeat = new Map();
    PLAN_CACHE.set(state, bySeat);
  }
  const cached = bySeat.get(seat);
  if (cached) return cached;
  const computed = computePlans(state, seat);
  bySeat.set(seat, computed);
  return computed;
}

function computePlans(state: BrState, seat: SeatId): UnitPlan[] {
  const seen = visionOf(state, seat);
  const enemies = visibleEnemies(state, seat, seen);
  const blocked = new Set(enemies.map(key));
  const own = ownUnits(state, seat);
  const passable = new Set(own.map(key));
  return own.map((unit) => ({
    unit,
    reaches: [
      { x: unit.x, y: unit.y, cost: 0, path: [] },
      ...reachableTiles(state.map, unit, CLASSES[unit.cls].move, blocked, passable),
    ].map((reach) => ({
      ...reach,
      targets: enemies
        .filter((enemy) => attackBlocker(state.map, reach, unit.cls, enemy) === null)
        .map((enemy) => enemy.id),
    })),
  }));
}

export function rememberSightings(state: BrState): BrState {
  const memory: BrState["memory"] = {};
  for (const seat of state.seats) {
    const entries: Record<string, SeenUnit> = { ...(state.memory[seat] ?? {}) };
    if (!isEliminated(state, seat))
      for (const enemy of visibleEnemies(state, seat))
        entries[enemy.id] = {
          id: enemy.id,
          seat: enemy.seat,
          cls: enemy.cls,
          x: enemy.x,
          y: enemy.y,
          hp: enemy.hp,
          round: state.round,
        };
    memory[seat] = entries;
  }
  return { ...state, memory };
}

export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

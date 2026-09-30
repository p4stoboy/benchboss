import type { SeatId } from "@benchboss/core";
import { ABILITIES, CLASSES } from "./classes";
import { attackBlocker } from "./combat";
import { type GameMap, chebyshev, inBounds, key } from "./map";
import { type Reach, reachableTiles } from "./path";
import type { BrState, Item, Point, Reveal, Unit } from "./types";
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
export const abilityReady = (state: BrState, unit: Unit): boolean => state.round >= unit.readyRound;
export const isHidden = (state: BrState, unit: Unit): boolean => unit.hiddenUntil >= state.round;

export const hasUnits = (state: BrState, seat: SeatId): boolean =>
  state.units.some((u) => u.seat === seat && u.alive);
/** Living seats that still field a unit. */
export const armedSeats = (state: BrState): SeatId[] =>
  aliveSeats(state).filter((seat) => hasUnits(state, seat));

/** Seats rotate through first initiative each round; eliminated seats are skipped. */
export function initiative(state: BrState): SeatId[] {
  const n = state.seats.length;
  const start = (state.round - 1) % n;
  const rotated = [...state.seats.slice(start), ...state.seats.slice(0, start)];
  return rotated.filter((seat) => !isEliminated(state, seat));
}

const actedSeats = (state: BrState): Set<SeatId> => new Set(state.turns.map((t) => t.seat));

/** The seat whose turn it is: first in initiative with no turn yet and a living unit. */
export function actingSeat(state: BrState): SeatId | null {
  if (state.phase !== "orders") return null;
  const acted = actedSeats(state);
  return initiative(state).find((seat) => !acted.has(seat) && hasUnits(state, seat)) ?? null;
}

/** Turns keep coming while a seat is due and at least two seats still field units. */
export const turnsRemain = (state: BrState): boolean =>
  actingSeat(state) !== null && armedSeats(state).length >= 2;

export type TurnStatus = "acted" | "acting" | "waiting" | "skipped";

/** Every living seat in initiative order with where it stands in the round. */
export function turnOrder(state: BrState): { seat: SeatId; status: TurnStatus }[] {
  if (state.phase !== "orders") return [];
  const acted = actedSeats(state);
  const acting = actingSeat(state);
  return initiative(state).map((seat) => ({
    seat,
    status: acted.has(seat)
      ? "acted"
      : seat === acting
        ? "acting"
        : hasUnits(state, seat)
          ? "waiting"
          : "skipped",
  }));
}

export const activeReveals = (state: BrState, seat: SeatId): Reveal[] =>
  state.reveals.filter((r) => r.seat === seat && r.untilRound >= state.round);

const inReveal = (reveals: readonly Reveal[], p: Point): boolean =>
  reveals.some((r) => chebyshev(r.center, p) <= r.radius);

/** Line-of-sight vision of the seat's living units plus its active recon discs. */
export function visionOf(state: BrState, seat: SeatId): Set<string> {
  const seen = visibleTiles(state.map, state.units, seat);
  for (const reveal of activeReveals(state, seat)) addDisc(state.map, seen, reveal);
  return seen;
}

function addDisc(map: GameMap, seen: Set<string>, reveal: Reveal): void {
  const { center, radius } = reveal;
  for (let y = center.y - radius; y <= center.y + radius; y++)
    for (let x = center.x - radius; x <= center.x + radius; x++)
      if (inBounds(map, { x, y })) seen.add(key({ x, y }));
}

/**
 * Living enemies on seen tiles. A camouflaged enemy is only visible when one of the seat's
 * living units is adjacent to it or it stands inside one of the seat's active recon discs.
 */
export function visibleEnemies(state: BrState, seat: SeatId, seen = visionOf(state, seat)): Unit[] {
  const own = ownUnits(state, seat);
  const reveals = activeReveals(state, seat);
  return state.units.filter(
    (u) =>
      u.alive &&
      u.seat !== seat &&
      seen.has(key(u)) &&
      (!isHidden(state, u) || own.some((o) => chebyshev(o, u) <= 1) || inReveal(reveals, u)),
  );
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

/**
 * Movement is planned over the tiles the team can see now: fog is impassable until seen. Shots
 * assume unseen tiles on the sight line are clear, so the listing reads no unseen terrain; the
 * true line is checked at resolution and a blocked shot fizzles.
 */
function computePlans(state: BrState, seat: SeatId): UnitPlan[] {
  const seen = visionOf(state, seat);
  const known = (p: Point): boolean => seen.has(key(p));
  const enemies = visibleEnemies(state, seat, seen);
  const blocked = new Set(enemies.map(key));
  const own = ownUnits(state, seat);
  const passable = new Set(own.map(key));
  return own.map((unit) => ({
    unit,
    reaches: [
      { x: unit.x, y: unit.y, cost: 0, path: [] },
      ...reachableTiles(state.map, unit, CLASSES[unit.cls].move, blocked, passable, seen),
    ].map((reach) => ({
      ...reach,
      targets: enemies
        .filter((enemy) => attackBlocker(state.map, reach, unit.weapon, enemy, known) === null)
        .map((enemy) => enemy.id),
    })),
  }));
}

/** Where a unit can still walk after acting at `from`, with the points its first leg left. */
export function continuations(state: BrState, seat: SeatId, unit: Unit, from: Reach): Reach[] {
  const seen = visionOf(state, seat);
  const blocked = new Set(visibleEnemies(state, seat, seen).map(key));
  // The unit vacates its own tile on the first leg, so it may end the second leg there.
  const passable = new Set(
    ownUnits(state, seat)
      .filter((u) => u.id !== unit.id)
      .map(key),
  );
  const remaining = CLASSES[unit.cls].move - from.cost;
  return remaining > 0 ? reachableTiles(state.map, from, remaining, blocked, passable, seen) : [];
}

/** Items on tiles the seat sees now. Remembering earlier sightings is the agent's job. */
export const visibleItems = (state: BrState, seat: SeatId, seen = visionOf(state, seat)): Item[] =>
  state.items.filter((item) => seen.has(key(item)));

/**
 * The spectator's explored set: every tile the given living teams see now joins it. Only a
 * team's own turn (or the spawn) can show it new tiles, so callers pass the seats that moved.
 */
export function markExplored(state: BrState, seats: readonly SeatId[] = state.seats): BrState {
  const explored: BrState["explored"] = { ...state.explored };
  for (const seat of seats)
    if (!isEliminated(state, seat)) for (const tile of visionOf(state, seat)) explored[tile] = true;
  return { ...state, explored };
}

export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

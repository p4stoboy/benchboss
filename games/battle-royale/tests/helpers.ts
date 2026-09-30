import { type SeatId, mkSeatId } from "@benchboss/core";
import { gameConfig } from "../../tests/config";
import { CLASSES, type ClassId } from "../src/classes";
import { makeBattleRoyale } from "../src/game";
import type { GameMap, Tile, TileKind } from "../src/map";
import { plugin } from "../src/plugin";
import { snapshot } from "../src/resolve";
import { rememberItems } from "../src/state";
import type { BrState, Item, Unit } from "../src/types";

export const game = makeBattleRoyale();
export const seatsOf = (n: number): SeatId[] => Array.from({ length: n }, (_, i) => mkSeatId(i));
export const configFor = (n: number, rules: Record<string, unknown> = {}) =>
  gameConfig(plugin.manifest, `br-${n}`, seatsOf(n), rules);
export const newMatch = (n: number, seed = "br-seed", rules: Record<string, unknown> = {}) =>
  game.newMatch(configFor(n, rules), seed);

/** A map with explicit rows: digits are heights on open ground; `#` wall and `+` cover sit at height 0. */
export function mapFromRows(rows: string[], spawns: GameMap["spawns"] = []): GameMap {
  const tiles: Tile[][] = rows.map((row) =>
    [...row].map((ch): Tile => {
      if (ch === "#") return { h: 0, kind: "wall" as TileKind };
      if (ch === "+") return { h: 0, kind: "cover" as TileKind };
      return { h: Number(ch), kind: "open" };
    }),
  );
  return { width: rows[0]?.length ?? 0, height: rows.length, tiles, spawns };
}

export const flatRows = (width: number, height: number): string[] =>
  Array.from({ length: height }, () => "0".repeat(width));

export interface UnitSpec {
  seat: number;
  slot?: number;
  cls: ClassId;
  x: number;
  y: number;
  hp?: number;
  armour?: number;
  weapon?: Unit["weapon"];
  readyRound?: number;
  hiddenUntil?: number;
}

/** A mid-match state in the orders phase with the given units placed and no loot unless given; teams know the items they can see. */
export function scenario(
  rows: string[],
  specs: UnitSpec[],
  overrides: Partial<BrState> = {},
  items: Item[] = [],
): BrState {
  const seatCount = Math.max(2, ...specs.map((s) => s.seat + 1));
  const base = newMatch(seatCount);
  const slots: Record<number, number> = {};
  const units: Unit[] = specs.map((spec) => {
    const nextSlot = (slots[spec.seat] ?? -1) + 1;
    slots[spec.seat] = nextSlot;
    const slot = spec.slot ?? nextSlot;
    const seat = mkSeatId(spec.seat);
    return {
      id: `${seat}/${slot}`,
      seat,
      slot,
      cls: spec.cls,
      x: spec.x,
      y: spec.y,
      hp: spec.hp ?? CLASSES[spec.cls].hp,
      alive: true,
      weapon: spec.weapon ?? CLASSES[spec.cls].weapon,
      armour: spec.armour ?? 0,
      readyRound: spec.readyRound ?? 1,
      hiddenUntil: spec.hiddenUntil ?? 0,
    };
  });
  const loadouts = Object.fromEntries(
    seatsOf(seatCount).map((seat) => [
      seat,
      units.filter((u) => u.seat === seat).map((u) => u.cls),
    ]),
  ) as BrState["loadouts"];
  const built: BrState = {
    ...base,
    phase: "orders",
    round: 1,
    rules: { maxRounds: 200, tilesPerSeat: 25 },
    map: mapFromRows(rows),
    loadouts,
    units,
    items,
    reveals: [],
    itemMemory: {},
    recentKills: {},
    explored: {},
  };
  return rememberItems({ ...built, history: [snapshot(built, 0, [])], ...overrides });
}

export const unit = (state: BrState, id: string): Unit => {
  const found = state.units.find((u) => u.id === id);
  if (!found) throw Error(`missing unit ${id}`);
  return found;
};

export function submitAll(state: BrState, orders: Record<string, unknown>): BrState {
  let next = state;
  for (const seat of state.seats) {
    if (next.teams[seat]?.placement !== null) continue;
    const result = game.submit(next, seat, orders[seat] ?? { orders: [] }, "match.orders");
    if (!result.accepted) throw Error(`${seat}: ${result.reason}`);
    next = result.state;
  }
  return game.step(next);
}

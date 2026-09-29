import type { SeatId } from "@benchboss/core";
import { CLASSES } from "./classes";
import { attackBlocker, damageFor } from "./combat";
import { chebyshev, inZone, key, stormDamage } from "./map";
import { aliveSeats, initiative, isEliminated, maxHp, rememberSightings, unitById } from "./state";
import type { BrState, RoundEvent, Unit } from "./types";

const occupied = (units: readonly Unit[], p: { x: number; y: number }): boolean =>
  units.some((u) => u.alive && u.x === p.x && u.y === p.y);

function moveUnits(state: BrState, events: RoundEvent[]): Unit[] {
  const units = state.units.map((u) => ({ ...u }));
  for (const seat of initiative(state))
    for (const order of state.orders[seat]?.orders ?? []) {
      const path = state.paths[seat]?.[order.unit];
      const unit = units.find((u) => u.id === order.unit);
      if (!path?.length || !unit?.alive) continue;
      const from = { x: unit.x, y: unit.y };
      let blocked = false;
      for (const step of path) {
        if (occupied(units, step)) {
          blocked = true;
          break;
        }
        unit.x = step.x;
        unit.y = step.y;
      }
      events.push({ kind: "move", unit: unit.id, from, to: { x: unit.x, y: unit.y }, blocked });
    }
  return units;
}

interface Applied {
  units: Unit[];
  kills: Record<SeatId, number>;
  damageDealt: Record<SeatId, number>;
}

function applyActions(state: BrState, units: Unit[], events: RoundEvent[]): Applied {
  const damage: Record<string, number> = {};
  const healing: Record<string, number> = {};
  const lastHitter: Record<string, SeatId> = {};
  const damageDealt: Record<SeatId, number> = {};
  const kills: Record<SeatId, number> = {};
  for (const seat of initiative(state))
    for (const order of state.orders[seat]?.orders ?? []) {
      const unit = units.find((u) => u.id === order.unit);
      const action = order.action;
      if (!unit?.alive || !action || action.kind === "hold") continue;
      const target = units.find((u) => u.id === action.target);
      if (!target?.alive) {
        events.push({
          kind: "fizzle",
          unit: unit.id,
          target: action.target,
          reason: "target gone",
        });
        continue;
      }
      if (action.kind === "attack") {
        const blocker = attackBlocker(state.map, unit, unit.cls, target);
        if (blocker) {
          events.push({ kind: "fizzle", unit: unit.id, target: target.id, reason: blocker });
          continue;
        }
        const amount = damageFor(state.map, unit, unit.cls, target);
        damage[target.id] = (damage[target.id] ?? 0) + amount;
        lastHitter[target.id] = seat;
        damageDealt[seat] = (damageDealt[seat] ?? 0) + amount;
        events.push({
          kind: "attack",
          unit: unit.id,
          from: { x: unit.x, y: unit.y },
          target: target.id,
          at: { x: target.x, y: target.y },
          damage: amount,
        });
        continue;
      }
      if (chebyshev(unit, target) > 1) {
        events.push({ kind: "fizzle", unit: unit.id, target: target.id, reason: "not adjacent" });
        continue;
      }
      const amount = CLASSES[unit.cls].heal;
      healing[target.id] = (healing[target.id] ?? 0) + amount;
      events.push({
        kind: "heal",
        unit: unit.id,
        from: { x: unit.x, y: unit.y },
        target: target.id,
        at: { x: target.x, y: target.y },
        amount,
      });
    }
  // Damage and healing land together, so simultaneous attackers cannot pre-empt each other.
  for (const unit of units) {
    if (!unit.alive) continue;
    unit.hp = Math.min(maxHp(unit), unit.hp - (damage[unit.id] ?? 0) + (healing[unit.id] ?? 0));
    if (unit.hp > 0) continue;
    unit.hp = 0;
    unit.alive = false;
    events.push({ kind: "death", unit: unit.id, at: { x: unit.x, y: unit.y } });
    const killer = lastHitter[unit.id];
    if (killer !== undefined) kills[killer] = (kills[killer] ?? 0) + 1;
  }
  return { units, kills, damageDealt };
}

function applyStorm(state: BrState, units: Unit[], events: RoundEvent[]): void {
  const amount = stormDamage(state.round);
  for (const unit of units) {
    if (!unit.alive || inZone(state.map, state.rules.maxRounds, state.round, unit)) continue;
    unit.hp = Math.max(0, unit.hp - amount);
    events.push({ kind: "storm", unit: unit.id, at: { x: unit.x, y: unit.y }, damage: amount });
    if (unit.hp > 0) continue;
    unit.alive = false;
    events.push({ kind: "death", unit: unit.id, at: { x: unit.x, y: unit.y } });
  }
}

/** Seats with no living units leave together; they share 1 + the number of teams left. */
export function eliminateEmptyTeams(state: BrState, events: RoundEvent[]): BrState {
  const teams = { ...state.teams };
  const gone = aliveSeats(state).filter(
    (seat) => !state.units.some((u) => u.seat === seat && u.alive),
  );
  const placement = 1 + aliveSeats(state).length - gone.length;
  for (const seat of gone) {
    const record = teams[seat];
    if (!record) continue;
    teams[seat] = { ...record, placement, eliminatedRound: state.round };
    events.push({ kind: "eliminated", seat, placement });
  }
  return { ...state, teams };
}

/** Standard competition ranking of the survivors by units, hit points, then damage dealt. */
export function rankSurvivors(state: BrState): BrState {
  const survivors = aliveSeats(state);
  const strength = (seat: SeatId): [number, number, number] => {
    const units = state.units.filter((u) => u.seat === seat && u.alive);
    return [
      units.length,
      units.reduce((sum, u) => sum + u.hp, 0),
      state.teams[seat]?.damageDealt ?? 0,
    ];
  };
  const beats = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  const teams = { ...state.teams };
  for (const seat of survivors) {
    const mine = strength(seat);
    const placement = 1 + survivors.filter((other) => beats(strength(other), mine)).length;
    const record = teams[seat];
    if (record) teams[seat] = { ...record, placement, eliminatedRound: null };
  }
  return { ...state, teams };
}

export function finishIfDecided(state: BrState): BrState {
  const alive = aliveSeats(state);
  if (alive.length > 1 && state.round <= state.rules.maxRounds) return state;
  const ranked = alive.length ? rankSurvivors(state) : state;
  return { ...ranked, phase: "terminal", orders: {}, paths: {} };
}

export function resolveRound(state: BrState): BrState {
  const events: RoundEvent[] = [];
  const moved = moveUnits(state, events);
  const { units, kills, damageDealt } = applyActions(state, moved, events);
  applyStorm(state, units, events);
  const teams = { ...state.teams };
  for (const seat of state.seats) {
    const record = teams[seat];
    if (!record) continue;
    teams[seat] = {
      ...record,
      kills: record.kills + (kills[seat] ?? 0),
      damageDealt: record.damageDealt + (damageDealt[seat] ?? 0),
    };
  }
  let next: BrState = { ...state, units, teams };
  next = eliminateEmptyTeams(next, events);
  next = {
    ...next,
    history: [
      ...next.history,
      {
        round: next.round,
        units: next.units
          .filter((u) => u.alive)
          .map((u) => ({ id: u.id, x: u.x, y: u.y, hp: u.hp })),
      },
    ],
    lastRound: events,
    orders: {},
    paths: {},
    round: next.round + 1,
  };
  next = rememberSightings(next);
  return finishIfDecided(next);
}

/** Host-enforced removal of a batch of seats (player time exhaustion). */
export function forfeitSeats(state: BrState, seats: readonly SeatId[], cause: string): BrState {
  const victims = seats.filter((seat) => state.seats.includes(seat) && !isEliminated(state, seat));
  if (!victims.length || state.phase === "terminal") return state;
  const events: RoundEvent[] = [...state.lastRound];
  const units = state.units.map((u) =>
    victims.includes(u.seat) && u.alive ? { ...u, alive: false, hp: 0 } : u,
  );
  for (const unit of units)
    if (victims.includes(unit.seat) && unitById(state, unit.id)?.alive)
      events.push({ kind: "death", unit: unit.id, at: { x: unit.x, y: unit.y } });
  let next: BrState = { ...state, units, cause };
  const placement = 1 + aliveSeats(next).length - victims.length;
  const teams = { ...next.teams };
  for (const seat of victims) {
    const record = teams[seat];
    if (record) teams[seat] = { ...record, placement, eliminatedRound: state.round };
    events.push({ kind: "eliminated", seat, placement });
  }
  next = { ...next, teams, lastRound: events };
  if (next.phase === "loadout") {
    const loadouts = { ...next.loadouts };
    for (const seat of victims) delete loadouts[seat];
    next = { ...next, loadouts };
  } else {
    const orders = { ...next.orders };
    const paths = { ...next.paths };
    for (const seat of victims) {
      delete orders[seat];
      delete paths[seat];
    }
    next = { ...next, orders, paths };
  }
  return aliveSeats(next).length <= 1 ? finishIfDecided(next) : next;
}

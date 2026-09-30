import type { SeatId } from "@benchboss/core";
import { ABILITIES, ARMOUR_PICKUP, CLASSES, HEALTH_PICKUP, MAX_ARMOUR } from "./classes";
import { attackBlocker, damageFor } from "./combat";
import { chebyshev, inZone, key, stormDamage, zoneRadius } from "./map";
import { aliveSeats, initiative, isEliminated, maxHp, rememberSightings, unitById } from "./state";
import type { BrState, Item, Point, Reveal, RoundEvent, RoundSnapshot, Unit } from "./types";

/** History entry for `round` from the given living units and the events that produced them. */
export function snapshot(state: BrState, round: number, events: RoundEvent[]): RoundSnapshot {
  const effective = Math.max(1, round);
  return {
    round,
    zoneRadius: zoneRadius(state.map, state.rules.maxRounds, effective),
    stormDamage: stormDamage(effective),
    units: state.units
      .filter((u) => u.alive)
      .map((u) => ({
        id: u.id,
        x: u.x,
        y: u.y,
        hp: u.hp,
        armour: u.armour,
        weapon: u.weapon,
        readyRound: u.readyRound,
        hiddenUntil: u.hiddenUntil,
      })),
    items: state.items.map((item) => ({ ...item })),
    events: [...events],
  };
}

const occupied = (units: readonly Unit[], p: { x: number; y: number }): boolean =>
  units.some((u) => u.alive && u.x === p.x && u.y === p.y);
const at = (u: Point): Point => ({ x: u.x, y: u.y });

function moveUnits(state: BrState, events: RoundEvent[]): Unit[] {
  const units = state.units.map((u) => ({ ...u }));
  for (const seat of initiative(state))
    for (const order of state.orders[seat]?.orders ?? []) {
      const path = state.paths[seat]?.[order.unit];
      const unit = units.find((u) => u.id === order.unit);
      if (!path?.length || !unit?.alive) continue;
      const from = at(unit);
      const walked: Point[] = [];
      let blocked = false;
      for (const step of path) {
        if (occupied(units, step)) {
          blocked = true;
          break;
        }
        unit.x = step.x;
        unit.y = step.y;
        walked.push({ x: step.x, y: step.y });
      }
      events.push({ kind: "move", unit: unit.id, from, to: at(unit), path: walked, blocked });
    }
  return units;
}

/** Pickups and self-targeted abilities land before any damage, in initiative order. */
function applyPickupsAndBuffs(
  state: BrState,
  units: Unit[],
  items: Item[],
  reveals: Reveal[],
  events: RoundEvent[],
): void {
  for (const seat of initiative(state))
    for (const order of state.orders[seat]?.orders ?? []) {
      const unit = units.find((u) => u.id === order.unit);
      const action = order.action;
      if (!unit?.alive || !action) continue;
      if (action.kind === "pickup") {
        const index = items.findIndex((item) => key(item) === key(unit));
        const item = items[index];
        if (!item) {
          events.push({ kind: "fizzle", unit: unit.id, target: "", reason: "nothing to pick up" });
          continue;
        }
        if (item.kind === "health") {
          unit.hp = Math.min(maxHp(unit), unit.hp + HEALTH_PICKUP);
          items.splice(index, 1);
          events.push({ kind: "pickup", unit: unit.id, at: at(unit), item: "health" });
        } else if (item.kind === "armour") {
          unit.armour = Math.min(MAX_ARMOUR, unit.armour + ARMOUR_PICKUP);
          items.splice(index, 1);
          events.push({ kind: "pickup", unit: unit.id, at: at(unit), item: "armour" });
        } else {
          const dropped = unit.weapon;
          unit.weapon = item.weapon;
          items[index] = { x: item.x, y: item.y, kind: "weapon", weapon: dropped };
          events.push({
            kind: "pickup",
            unit: unit.id,
            at: at(unit),
            item: "weapon",
            weapon: item.weapon,
            dropped,
          });
        }
        continue;
      }
      if (action.kind !== "ability") continue;
      const ability = CLASSES[unit.cls].ability;
      const spec = ABILITIES[ability];
      if (spec.target !== "none") continue;
      if (ability === "brace") unit.armour = Math.min(MAX_ARMOUR, unit.armour + spec.amount);
      else if (ability === "camo") unit.hiddenUntil = state.round + spec.duration;
      else if (ability === "recon")
        reveals.push({
          seat,
          center: at(unit),
          radius: spec.radius,
          untilRound: state.round + spec.duration,
        });
      unit.readyRound = state.round + spec.cooldown + 1;
      events.push({ kind: "ability", unit: unit.id, ability, from: at(unit) });
    }
}

interface Applied {
  kills: Record<SeatId, number>;
  damageDealt: Record<SeatId, number>;
}

/** Attacks, targeted abilities and heals against post-movement positions, summed before deaths. */
function applyCombat(state: BrState, units: Unit[], events: RoundEvent[]): Applied {
  const damage: Record<string, number> = {};
  const healing: Record<string, number> = {};
  const lastHitter: Record<string, SeatId> = {};
  const damageDealt: Record<SeatId, number> = {};
  const kills: Record<SeatId, number> = {};
  const hit = (seat: SeatId, target: Unit, amount: number): void => {
    damage[target.id] = (damage[target.id] ?? 0) + amount;
    if (target.seat !== seat) lastHitter[target.id] = seat;
    damageDealt[seat] = (damageDealt[seat] ?? 0) + amount;
  };
  const fizzle = (unit: Unit, target: string, reason: string): void => {
    events.push({ kind: "fizzle", unit: unit.id, target, reason });
  };
  for (const seat of initiative(state))
    for (const order of state.orders[seat]?.orders ?? []) {
      const unit = units.find((u) => u.id === order.unit);
      const action = order.action;
      if (!unit?.alive || !action || action.kind === "hold" || action.kind === "pickup") continue;
      if (action.kind === "attack") {
        const target = units.find((u) => u.id === action.target);
        if (!target?.alive) {
          fizzle(unit, action.target, "target gone");
          continue;
        }
        const blocker = attackBlocker(state.map, unit, unit.weapon, target);
        if (blocker) {
          fizzle(unit, target.id, blocker);
          continue;
        }
        const amount = damageFor(state.map, unit, unit.weapon, target);
        hit(seat, target, amount);
        unit.hiddenUntil = 0;
        events.push({
          kind: "attack",
          unit: unit.id,
          from: at(unit),
          target: target.id,
          at: at(target),
          damage: amount,
        });
        continue;
      }
      const ability = CLASSES[unit.cls].ability;
      const spec = ABILITIES[ability];
      if (spec.target === "none") continue;
      if (spec.target === "point") {
        const centre = action.at;
        if (!centre) continue;
        if (chebyshev(unit, centre) > spec.range) {
          fizzle(unit, "", "out of range");
          continue;
        }
        unit.readyRound = state.round + spec.cooldown + 1;
        unit.hiddenUntil = 0;
        events.push({ kind: "ability", unit: unit.id, ability, from: at(unit), at: centre });
        for (const victim of units) {
          if (!victim.alive || chebyshev(victim, centre) > spec.radius) continue;
          hit(seat, victim, spec.amount);
          events.push({
            kind: "blast",
            unit: unit.id,
            target: victim.id,
            at: at(victim),
            damage: spec.amount,
          });
        }
        continue;
      }
      const target = units.find((u) => u.id === action.target);
      if (!target?.alive) {
        fizzle(unit, action.target ?? "", "target gone");
        continue;
      }
      if (spec.target === "enemy") {
        const blocker = attackBlocker(state.map, unit, unit.weapon, target);
        if (blocker) {
          fizzle(unit, target.id, blocker);
          continue;
        }
        unit.readyRound = state.round + spec.cooldown + 1;
        unit.hiddenUntil = 0;
        events.push({
          kind: "ability",
          unit: unit.id,
          ability,
          from: at(unit),
          target: target.id,
        });
        for (const victim of units) {
          if (!victim.alive || victim.seat === seat || chebyshev(victim, target) > spec.radius)
            continue;
          const amount = damageFor(state.map, unit, unit.weapon, victim);
          hit(seat, victim, amount);
          events.push({
            kind: "blast",
            unit: unit.id,
            target: victim.id,
            at: at(victim),
            damage: amount,
          });
        }
        continue;
      }
      if (chebyshev(unit, target) > spec.radius) {
        fizzle(unit, target.id, "not adjacent");
        continue;
      }
      unit.readyRound = state.round + spec.cooldown + 1;
      healing[target.id] = (healing[target.id] ?? 0) + spec.amount;
      events.push({ kind: "ability", unit: unit.id, ability, from: at(unit), target: target.id });
      events.push({
        kind: "heal",
        unit: unit.id,
        from: at(unit),
        target: target.id,
        at: at(target),
        amount: spec.amount,
      });
    }
  // Damage and healing land together, so simultaneous attackers cannot pre-empt each other.
  for (const unit of units) {
    if (!unit.alive) continue;
    const total = damage[unit.id] ?? 0;
    const absorbed = Math.min(unit.armour, total);
    unit.armour -= absorbed;
    unit.hp = Math.min(maxHp(unit), unit.hp - (total - absorbed) + (healing[unit.id] ?? 0));
    if (unit.hp > 0) continue;
    unit.hp = 0;
    unit.alive = false;
    events.push({ kind: "death", unit: unit.id, at: at(unit) });
    const killer = lastHitter[unit.id];
    if (killer !== undefined) kills[killer] = (kills[killer] ?? 0) + 1;
  }
  return { kills, damageDealt };
}

/** The storm ignores armour. */
function applyStorm(state: BrState, units: Unit[], events: RoundEvent[]): void {
  const amount = stormDamage(state.round);
  for (const unit of units) {
    if (!unit.alive || inZone(state.map, state.rules.maxRounds, state.round, unit)) continue;
    unit.hp = Math.max(0, unit.hp - amount);
    events.push({ kind: "storm", unit: unit.id, at: at(unit), damage: amount });
    if (unit.hp > 0) continue;
    unit.alive = false;
    events.push({ kind: "death", unit: unit.id, at: at(unit) });
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
  const units = moveUnits(state, events);
  const items = state.items.map((item) => ({ ...item }));
  // Reveals that outlive this round stay; anything older is dropped here.
  const reveals = state.reveals.filter((r) => r.untilRound > state.round);
  applyPickupsAndBuffs(state, units, items, reveals, events);
  const { kills, damageDealt } = applyCombat(state, units, events);
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
  let next: BrState = { ...state, units, items, reveals, teams, recentKills: kills };
  next = eliminateEmptyTeams(next, events);
  next = {
    ...next,
    history: [...next.history, snapshot(next, next.round, events)],
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
  const forfeits: RoundEvent[] = [];
  const units = state.units.map((u) =>
    victims.includes(u.seat) && u.alive ? { ...u, alive: false, hp: 0 } : u,
  );
  for (const unit of units)
    if (victims.includes(unit.seat) && unitById(state, unit.id)?.alive)
      forfeits.push({ kind: "death", unit: unit.id, at: at(unit) });
  let next: BrState = { ...state, units, cause, recentKills: {} };
  const placement = 1 + aliveSeats(next).length - victims.length;
  const teams = { ...next.teams };
  for (const seat of victims) {
    const record = teams[seat];
    if (record) teams[seat] = { ...record, placement, eliminatedRound: state.round };
    forfeits.push({ kind: "eliminated", seat, placement });
  }
  next = {
    ...next,
    teams,
    lastRound: [...state.lastRound, ...forfeits],
    history: [...next.history, snapshot(next, state.round, forfeits)],
  };
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

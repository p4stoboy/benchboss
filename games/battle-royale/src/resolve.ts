import type { SeatId } from "@benchboss/core";
import { ABILITIES, ARMOUR_PICKUP, CLASSES, HEALTH_PICKUP, MAX_ARMOUR } from "./classes";
import { attackBlocker, damageFor } from "./combat";
import { chebyshev, inZone, key, stormDamage, zoneRadius } from "./map";
import { aliveSeats, isEliminated, markExplored, maxHp, unitById } from "./state";
import type {
  BrState,
  Item,
  Point,
  Reveal,
  RoundEvent,
  RoundSnapshot,
  Unit,
  UnitOrder,
} from "./types";

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

const occupied = (units: readonly Unit[], p: Point, passable?: SeatId): boolean =>
  units.some((u) => u.alive && u.seat !== passable && u.x === p.x && u.y === p.y);
const at = (u: Point): Point => ({ x: u.x, y: u.y });

/** The acting seat's orders with the paths accepted for them. */
interface Turn {
  seat: SeatId;
  orders: UnitOrder[];
  paths: Record<string, Point[][]>;
}

/**
 * One movement leg, orders in the order given. Allies are walked through but never stopped on;
 * any unit, hidden or not, blocks the step onto its tile otherwise. A unit whose earlier leg
 * stopped short no longer stands where this leg's path begins, so it forfeits the leg; a dead
 * unit walks nowhere.
 */
function moveUnits(turn: Turn, units: Unit[], leg: number, events: RoundEvent[]): void {
  for (const order of turn.orders) {
    const path = turn.paths[order.unit]?.[leg];
    const unit = units.find((u) => u.id === order.unit);
    if (!path?.length || !unit?.alive) continue;
    const from = at(unit);
    const start = leg === 0 ? from : (turn.paths[order.unit]?.[leg - 1]?.at(-1) ?? from);
    if (start.x !== from.x || start.y !== from.y) continue;
    const walked: Point[] = [];
    let blocked = false;
    for (const [index, step] of path.entries()) {
      const last = index === path.length - 1;
      if (occupied(units, step, last ? undefined : turn.seat)) {
        blocked = true;
        break;
      }
      unit.x = step.x;
      unit.y = step.y;
      walked.push({ x: step.x, y: step.y });
    }
    events.push({ kind: "move", unit: unit.id, from, to: at(unit), path: walked, blocked });
  }
}

/** Pickups and self-targeted abilities land before any damage, in the order given. */
function applyPickupsAndBuffs(
  state: BrState,
  turn: Turn,
  units: Unit[],
  items: Item[],
  reveals: Reveal[],
  events: RoundEvent[],
): void {
  for (const order of turn.orders) {
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
        seat: turn.seat,
        center: at(unit),
        radius: spec.radius,
        untilRound: state.round + spec.duration,
      });
    unit.readyRound = state.round + spec.cooldown + 1;
    events.push({ kind: "ability", unit: unit.id, ability, from: at(unit) });
  }
}

interface Applied {
  kills: number;
  damageDealt: number;
}

/**
 * Attacks, targeted abilities and heals from first-leg positions. The turn's damage is summed
 * per target before deaths so two units on one enemy cannot overkill it into a second credit.
 */
function applyCombat(state: BrState, turn: Turn, units: Unit[], events: RoundEvent[]): Applied {
  const { seat } = turn;
  const damage: Record<string, number> = {};
  const healing: Record<string, number> = {};
  const applied: Applied = { kills: 0, damageDealt: 0 };
  const hit = (target: Unit, amount: number): void => {
    damage[target.id] = (damage[target.id] ?? 0) + amount;
    if (target.seat !== seat) applied.damageDealt += amount;
  };
  const fizzle = (unit: Unit, target: string, reason: string): void => {
    events.push({ kind: "fizzle", unit: unit.id, target, reason });
  };
  for (const order of turn.orders) {
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
      hit(target, amount);
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
        hit(victim, spec.amount);
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
        hit(victim, amount);
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
    // Only enemy hits reach here with damage; a unit killed by its own side's blast credits nobody.
    if (unit.seat !== seat && total > 0) applied.kills += 1;
  }
  return applied;
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
  return { ...ranked, phase: "terminal", pending: null };
}

/**
 * Resolves the pending seat's orders in full: first legs, pickups and self-abilities, attacks,
 * blasts and heals with immediate damage, then second legs. The next seat acts on the result.
 */
export function resolveTurn(state: BrState): BrState {
  const turn = state.pending;
  if (!turn) return state;
  const events: RoundEvent[] = [...state.events, { kind: "turn", seat: turn.seat }];
  const units = state.units.map((u) => ({ ...u }));
  moveUnits(turn, units, 0, events);
  const items = state.items.map((item) => ({ ...item }));
  const reveals = [...state.reveals];
  applyPickupsAndBuffs(state, turn, units, items, reveals, events);
  const { kills, damageDealt } = applyCombat(state, turn, units, events);
  moveUnits(turn, units, 1, events);
  const record = state.teams[turn.seat];
  if (!record) throw Error("pending orders name an unknown seat");
  const teams = {
    ...state.teams,
    [turn.seat]: {
      ...record,
      kills: record.kills + kills,
      damageDealt: record.damageDealt + damageDealt,
    },
  };
  return markExplored({
    ...state,
    units,
    items,
    reveals,
    teams,
    events,
    recentKills: { ...state.recentKills, [turn.seat]: kills },
    turns: [...state.turns, { seat: turn.seat, orders: turn.orders }],
    pending: null,
  });
}

/** Storm, eliminations and the round's history entry once every due seat has acted. */
export function endRound(state: BrState): BrState {
  const events = [...state.events];
  const units = state.units.map((u) => ({ ...u }));
  applyStorm(state, units, events);
  let next: BrState = eliminateEmptyTeams({ ...state, units }, events);
  next = {
    ...next,
    // Reveals that outlive this round stay; anything older is dropped here.
    reveals: next.reveals.filter((r) => r.untilRound > next.round),
    history: [...next.history, snapshot(next, next.round, events)],
    lastRound: events,
    events: [],
    turns: [],
    pending: null,
    round: next.round + 1,
  };
  return finishIfDecided(markExplored(next));
}

/**
 * Host-enforced removal of a batch of seats (player time exhaustion). The forfeit lands in the
 * round in progress; when it leaves at most one team the round's history entry closes there.
 */
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
  next = { ...next, teams, events: [...state.events, ...forfeits] };
  if (next.phase === "loadout") {
    const loadouts = { ...next.loadouts };
    for (const seat of victims) delete loadouts[seat];
    next = { ...next, loadouts };
  } else if (next.pending && victims.includes(next.pending.seat)) {
    next = { ...next, pending: null };
  }
  if (aliveSeats(next).length > 1) return next;
  return finishIfDecided({
    ...next,
    history: [...next.history, snapshot(next, next.round, next.events)],
    lastRound: next.events,
    events: [],
    turns: [],
  });
}

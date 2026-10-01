import {
  type GameModule,
  type LegalActionSpec,
  type MatchConfig,
  type SeatId,
  createRng,
} from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import {
  ABILITIES,
  CLASSES,
  CLASS_IDS,
  type ClassId,
  MAX_ARMOUR,
  TEAM_BUDGET,
  TEAM_SIZE,
  WEAPONS,
  type WeaponId,
  isAffordable,
} from "./classes";
import { generateMap } from "./generate";
import { scatterLoot } from "./loot";
import { type TileKind, chebyshev, inBounds, key, stormDamage } from "./map";
import type { Reach } from "./path";
import { endRound, resolveTurn, snapshot } from "./resolve";
import {
  CHAT_MAX_LENGTH,
  LOADOUT_INPUT_SCHEMA,
  ORDERS_INPUT_SCHEMA,
  loadoutSchema,
  ordersSchema,
} from "./schemas";
import {
  abilityReady,
  actingSeat,
  activeReveals,
  aliveSeats,
  continuations,
  isEliminated,
  markExplored,
  ownUnits,
  plans,
  samePoint,
  turnsRemain,
  unitById,
  visibleEnemies,
  visibleItems,
  visionOf,
} from "./state";
import type { BrState, ChatMessage, Item, Orders, Point, RoundEvent, Unit } from "./types";
import { zoneAt, zoneSchedule } from "./zone";

export const BR_GAME_ID = "battle-royale";
export const MIN_SEATS = 2;
export const MAX_SEATS = 30;
export const BR_DEFAULT_RULES = { maxRounds: 40, tilesPerSeat: 600 };
export const BR_RULES_SCHEMA = {
  type: "object",
  properties: {
    maxRounds: { type: "integer", minimum: 4, maximum: 200 },
    tilesPerSeat: { type: "integer", minimum: 9, maximum: 1200 },
  },
  additionalProperties: false,
};
/** Observations and live public views carry this many most recent chat lines. */
export const CHAT_WINDOW = 50;
export const BR_PHASE_TOOLS = {
  loadout: ["match.loadout"],
  orders: ["match.orders"],
  terminal: [],
} satisfies Record<string, string[]>;

export interface BrCatalog {
  classes: typeof CLASSES;
  weapons: typeof WEAPONS;
  abilities: typeof ABILITIES;
  maxArmour: number;
  budget: number;
  teamSize: number;
}

/** Sorted visible horizontal runs; omitted tiles are unseen, never padding. */
export interface BrView {
  rows: [x: number, y: number, terrain: string, heights: string][];
}

export interface BrCostGrid {
  x: number;
  y: number;
  rows: string[];
}

export interface BrObservation {
  matchId: string;
  phase: string;
  seat: SeatId;
  /** Empty unless the seat can act. */
  publicState: Partial<{
    round: number;
    maxRounds: number;
    map: { width: number; height: number };
    zone: {
      center: Point;
      radius: number;
      nextCenter: Point;
      nextRadius: number;
      stormDamage: number;
      nextStormDamage: number;
    };
    /** Sent during the loadout phase only; agents keep it. */
    catalog?: BrCatalog;
  }>;
  privateState: {
    /** True unless this seat is the one to act now; everything below is then empty. */
    committed: boolean;
    loadout: ClassId[] | null;
    view: BrView | null;
    units: {
      id: string;
      cls: ClassId;
      x: number;
      y: number;
      hp: number;
      armour: number;
      weapon: WeaponId;
      /** Class ability can be used when round >= readyRound. */
      readyRound: number;
      hiddenUntil: number;
      /**
       * Move cost to every tile the unit may end its first leg on, as a digit per tile in row
       * strings from the box origin; `.` is unreachable this round. Its own tile is `0`.
       */
      reach: BrCostGrid;
      /** Target id -> cost grid of first-leg destinations offering that shot. */
      shots: Record<string, BrCostGrid>;
    }[];
    visibleEnemies: {
      id: string;
      seat: SeatId;
      cls: ClassId;
      x: number;
      y: number;
      hp: number;
      armour: number;
      weapon: WeaponId;
    }[];
    /** Items on tiles this team sees now. Nothing is remembered for the team. */
    items: Item[];
    /** Events since this seat's previous turn, that turn included. */
    events: RoundEvent[];
    /** Previous rounds' lines, only in the turn after this seat scored a kill. */
    chat: ChatMessage[];
  };
  legalTools: string[];
}

const canLoadout = (state: BrState, seat: SeatId): boolean =>
  state.phase === "loadout" && !isEliminated(state, seat) && state.loadouts[seat] === undefined;
/** Only the acting seat orders, and only until its orders are accepted. */
export const canOrder = (state: BrState, seat: SeatId): boolean =>
  state.phase === "orders" && state.pending === null && actingSeat(state) === seat;

export const recentChat = (state: BrState): ChatMessage[] =>
  state.chat.slice(-CHAT_WINDOW).map((line) => ({ ...line }));

/** A seat reads previous rounds' chat only in the turn after it scored a kill. */
export const chatFor = (state: BrState, seat: SeatId): ChatMessage[] =>
  (state.recentKills[seat] ?? 0) > 0
    ? state.chat
        .filter((line) => line.round < state.round)
        .slice(-CHAT_WINDOW)
        .map((line) => ({ ...line }))
    : [];

const TERRAIN_CHAR: Record<TileKind, string> = { open: ".", cover: "+", wall: "#" };

/** Bounding box of a unit's reaches with one cost digit per tile and `.` where it cannot end. */
export function costGrid(reaches: readonly Reach[]): BrCostGrid {
  if (reaches.length === 0) return { x: 0, y: 0, rows: [] };
  const x0 = Math.min(...reaches.map((r) => r.x));
  const y0 = Math.min(...reaches.map((r) => r.y));
  const x1 = Math.max(...reaches.map((r) => r.x));
  const y1 = Math.max(...reaches.map((r) => r.y));
  const cost = new Map(reaches.map((r) => [key(r), r.cost]));
  const rows: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let row = "";
    for (let x = x0; x <= x1; x++) row += cost.get(`${x},${y}`)?.toString() ?? ".";
    rows.push(row);
  }
  return { x: x0, y: y0, rows };
}

/** Group shot destinations without repeating the same target id at every tile. */
export function shotGrids(
  reaches: readonly (Reach & { targets: string[] })[],
): Record<string, BrCostGrid> {
  const targets = new Map<string, Reach[]>();
  for (const reach of reaches)
    for (const target of reach.targets) {
      const cells = targets.get(target) ?? [];
      cells.push(reach);
      targets.set(target, cells);
    }
  return Object.fromEntries([...targets].map(([target, cells]) => [target, costGrid(cells)]));
}

/** Encode only visible cells, so separating a squad never transmits the fog between it. */
export function viewFor(state: BrState, seen: ReadonlySet<string>): BrView | null {
  if (seen.size === 0) return null;
  const points = [...seen]
    .map((tile) => tile.split(",").map(Number) as [number, number])
    .sort(([ax, ay], [bx, by]) => ay - by || ax - bx);
  const rows: BrView["rows"] = [];
  for (const [x, y] of points) {
    const tile = state.map.tiles[y]?.[x];
    if (!tile) continue;
    const previous = rows.at(-1);
    if (previous && previous[1] === y && previous[0] + previous[2].length === x) {
      previous[2] += TERRAIN_CHAR[tile.kind];
      previous[3] += String(tile.h);
    } else rows.push([x, y, TERRAIN_CHAR[tile.kind], String(tile.h)]);
  }
  return { rows };
}

const withChat = (state: BrState, seat: SeatId, text: string | undefined): BrState =>
  text === undefined
    ? state
    : { ...state, chat: [...state.chat, { round: state.round, seat, text }] };

/** Everything that happened since the seat's previous turn, that turn included. */
export function sinceLastTurn(state: BrState, seat: SeatId): RoundEvent[] {
  const own = state.lastRound.findLastIndex((e) => e.kind === "turn" && e.seat === seat);
  return [...state.lastRound.slice(Math.max(0, own)), ...state.events];
}

/** Own history and wholly observable enemy events; no off-screen identities or paths. */
export function eventsFor(state: BrState, seat: SeatId): RoundEvent[] {
  const seen = visionOf(state, seat);
  const own = (id: string): boolean => unitById(state, id)?.seat === seat;
  const visible = (p: Point): boolean => seen.has(key(p));
  const mine = ownUnits(state, seat);
  const reveals = activeReveals(state, seat);
  // Include visible corpses so witnessed deaths remain observable, but camouflage
  // still conceals an enemy unless adjacency or recon reveals it.
  const known = new Set(
    state.units
      .filter(
        (unit) =>
          unit.seat === seat ||
          (visible(unit) &&
            (state.round > unit.hiddenUntil ||
              mine.some((u) => chebyshev(u, unit) <= 1) ||
              reveals.some((r) => chebyshev(r.center, unit) <= r.radius))),
      )
      .map((unit) => unit.id),
  );
  const disclosed = sinceLastTurn(state, seat).map((event) =>
    event.kind === "fizzle" && event.target !== "" && !own(event.target)
      ? { ...event, target: known.has(event.target) ? event.target : "", reason: "missed" }
      : event,
  );
  return disclosed.filter((event) => {
    if (event.kind === "turn" || event.kind === "eliminated") return event.seat === seat;
    if (!known.has(event.unit)) return false;
    if ("target" in event && event.target && !known.has(event.target)) return false;
    // An own action can describe its submitted destination, but cannot disclose a
    // remote enemy's location or damage there. Current own hp always reports hits.
    if (own(event.unit))
      return !(
        "target" in event &&
        event.target &&
        !own(event.target) &&
        "at" in event &&
        event.at &&
        !visible(event.at)
      );
    if ("from" in event && !visible(event.from)) return false;
    if ("at" in event && event.at && !visible(event.at)) return false;
    if (event.kind === "move") return visible(event.to) && event.path.every(visible);
    return event.kind !== "fizzle";
  });
}

function spawn(state: BrState): BrState {
  const order = createRng(state.seed)
    .fork("spawn")
    .shuffle([...state.seats]);
  const units: Unit[] = [];
  order.forEach((seat, index) => {
    if (isEliminated(state, seat)) return;
    const roster = state.loadouts[seat];
    const tiles = state.map.spawns[index];
    if (!roster || !tiles) throw Error("missing roster or spawn cluster");
    roster.forEach((cls, slot) => {
      const tile = tiles[slot];
      if (!tile) throw Error("missing spawn tile");
      units.push({
        id: `${seat}/${slot}`,
        seat,
        slot,
        cls,
        x: tile.x,
        y: tile.y,
        hp: CLASSES[cls].hp,
        alive: true,
        weapon: CLASSES[cls].weapon,
        armour: 0,
        readyRound: 1,
        hiddenUntil: 0,
      });
    });
  });
  const spawned: BrState = { ...state, phase: "orders", round: 1, units };
  // Loadout-phase forfeits are the spawn entry's only events.
  return markExplored({
    ...spawned,
    history: [snapshot(spawned, 0, state.events)],
    lastRound: state.events,
    events: [],
  });
}

/** Loadout resolves when every living seat has chosen; a turn resolves once its orders are in. */
export function isReady(state: BrState): boolean {
  if (state.phase === "loadout")
    return aliveSeats(state).every((seat) => state.loadouts[seat] !== undefined);
  if (state.phase === "orders") return state.pending !== null || !turnsRemain(state);
  return false;
}

function validateOrders(
  state: BrState,
  seat: SeatId,
  orders: Orders,
): { ok: true; paths: Record<string, Point[][]> } | { ok: false; reason: string } {
  const planned = plans(state, seat);
  const enemies = new Set(visibleEnemies(state, seat).map((u) => u.id));
  const paths: Record<string, Point[][]> = {};
  const used = new Set<string>();
  const fail = (reason: string) => ({ ok: false as const, reason });
  // Reasons name only ids the state vouches for; unknown ids are never echoed.
  for (const [index, order] of orders.orders.entries()) {
    const plan = planned.find((p) => p.unit.id === order.unit);
    if (!plan) return fail(`order ${index} names no living unit of yours`);
    if (used.has(order.unit)) return fail(`duplicate order for ${order.unit}`);
    used.add(order.unit);
    const destination = order.moveTo ?? plan.unit;
    const reach = plan.reaches.find((r) => samePoint(r, destination));
    if (!reach) return fail(`${order.unit} cannot reach ${destination.x},${destination.y}`);
    paths[order.unit] = [reach.path];
    if (order.thenTo) {
      if (samePoint(order.thenTo, reach))
        return fail(`${order.unit} thenTo must differ from its destination`);
      const onward = continuations(state, seat, plan.unit, reach).find((r) =>
        samePoint(r, order.thenTo as Point),
      );
      if (!onward)
        return fail(
          `${order.unit} cannot continue to ${order.thenTo.x},${order.thenTo.y} from ${reach.x},${reach.y} with ${CLASSES[plan.unit.cls].move - reach.cost} move points left`,
        );
      paths[order.unit] = [reach.path, onward.path];
    }
    const action = order.action;
    if (!action || action.kind === "hold") continue;
    if (action.kind === "attack") {
      if (!enemies.has(action.target))
        return fail(`${order.unit} attack target is not a visible enemy`);
      if (!reach.targets.includes(action.target))
        return fail(`${order.unit} cannot attack ${action.target} from ${reach.x},${reach.y}`);
      continue;
    }
    if (action.kind === "pickup") {
      if (!state.items.some((item) => samePoint(item, reach)))
        return fail(`no known item to pick up at ${reach.x},${reach.y}`);
      continue;
    }
    if (!abilityReady(state, plan.unit))
      return fail(`${order.unit} ability is ready on round ${plan.unit.readyRound}`);
    const ability = CLASSES[plan.unit.cls].ability;
    const spec = ABILITIES[ability];
    if (spec.target === "none") {
      if (action.target !== undefined || action.at !== undefined)
        return fail(`${ability} takes no target`);
      continue;
    }
    if (spec.target === "point") {
      if (!action.at || action.target !== undefined) return fail(`${ability} needs a tile at`);
      if (!inBounds(state.map, action.at) || chebyshev(reach, action.at) > spec.range)
        return fail(
          `${order.unit} cannot throw to ${action.at.x},${action.at.y} from ${reach.x},${reach.y}`,
        );
      continue;
    }
    if (!action.target || action.at !== undefined) return fail(`${ability} needs a target unit`);
    if (spec.target === "enemy") {
      if (!enemies.has(action.target)) return fail(`${ability} target is not a visible enemy`);
      if (!reach.targets.includes(action.target))
        return fail(`${order.unit} cannot attack ${action.target} from ${reach.x},${reach.y}`);
      continue;
    }
    const ally = unitById(state, action.target);
    if (!ally?.alive || ally.seat !== seat || ally.id === order.unit)
      return fail(`${ability} target is not another living unit of yours`);
  }
  return { ok: true, paths };
}

export function makeBattleRoyale(): GameModule<BrState, unknown, BrObservation, number> {
  return {
    id: BR_GAME_ID,
    newMatch(config: MatchConfig, seed: string): BrState {
      const seats = config.seats;
      if (
        config.gameId !== BR_GAME_ID ||
        seats.length < MIN_SEATS ||
        seats.length > MAX_SEATS ||
        new Set(seats).size !== seats.length ||
        seats.some((seat) => typeof seat !== "string" || !/^seat:(0|[1-9][0-9]*)$/.test(seat))
      )
        throw Error(`Battle royale requires ${MIN_SEATS}-${MAX_SEATS} distinct seats`);
      if (!validateSchema(BR_RULES_SCHEMA, config.rules).ok)
        throw Error("Invalid battle royale rules");
      const rules = { ...BR_DEFAULT_RULES, ...(config.rules as Partial<typeof BR_DEFAULT_RULES>) };
      const map = generateMap(
        createRng(seed).fork("map"),
        seats.length,
        rules.tilesPerSeat,
        TEAM_SIZE,
      );
      const teams = Object.fromEntries(
        seats.map((seat) => [
          seat,
          { seat, placement: null, eliminatedRound: null, kills: 0, damageDealt: 0 },
        ]),
      ) as BrState["teams"];
      return {
        matchId: config.matchId,
        seed,
        phase: "loadout",
        seats: [...seats],
        rules,
        map,
        zones: zoneSchedule(createRng(seed).fork("zone"), map, rules.maxRounds),
        round: 0,
        loadouts: {},
        units: [],
        items: scatterLoot(createRng(seed).fork("loot"), map),
        reveals: [],
        turns: [],
        pending: null,
        events: [],
        teams,
        recentKills: {},
        explored: {},
        lastRound: [],
        history: [],
        chat: [],
        cause: null,
      };
    },
    observe(state, seat): BrObservation {
      const committed =
        isEliminated(state, seat) ||
        (state.phase === "loadout" && state.loadouts[seat] !== undefined) ||
        (state.phase === "orders" && !canOrder(state, seat)) ||
        state.phase === "terminal";
      if (committed)
        return {
          matchId: state.matchId,
          phase: state.phase,
          seat,
          publicState: {},
          privateState: {
            committed: true,
            loadout: null,
            view: null,
            units: [],
            visibleEnemies: [],
            items: [],
            events: [],
            chat: [],
          },
          legalTools: [],
        };
      const round = Math.max(1, state.round);
      const zone = zoneAt(state, round);
      const nextZone = zoneAt(state, round + 1);
      const publicState: BrObservation["publicState"] = {
        round: state.round,
        maxRounds: state.rules.maxRounds,
        map: { width: state.map.width, height: state.map.height },
        zone: {
          center: zone.center,
          radius: zone.radius,
          nextCenter: nextZone.center,
          nextRadius: nextZone.radius,
          stormDamage: stormDamage(round),
          nextStormDamage: stormDamage(round + 1),
        },
      };
      if (state.phase === "loadout")
        publicState.catalog = {
          classes: CLASSES,
          weapons: WEAPONS,
          abilities: ABILITIES,
          maxArmour: MAX_ARMOUR,
          budget: TEAM_BUDGET,
          teamSize: TEAM_SIZE,
        };
      const loadout = state.loadouts[seat] ? [...(state.loadouts[seat] as ClassId[])] : null;
      const legalTools = canLoadout(state, seat)
        ? [...BR_PHASE_TOOLS.loadout]
        : canOrder(state, seat)
          ? [...BR_PHASE_TOOLS.orders]
          : [];
      const seen = visionOf(state, seat);
      const enemies = visibleEnemies(state, seat, seen);
      const planned = state.phase === "orders" ? plans(state, seat) : [];
      return {
        matchId: state.matchId,
        phase: state.phase,
        seat,
        publicState,
        privateState: {
          committed: false,
          loadout,
          view: viewFor(state, seen),
          units: (planned.length
            ? planned
            : ownUnits(state, seat).map((unit) => ({ unit, reaches: [] }))
          ).map(({ unit, reaches }) => ({
            id: unit.id,
            cls: unit.cls,
            x: unit.x,
            y: unit.y,
            hp: unit.hp,
            armour: unit.armour,
            weapon: unit.weapon,
            readyRound: unit.readyRound,
            hiddenUntil: unit.hiddenUntil,
            reach: costGrid(reaches),
            shots: shotGrids(reaches),
          })),
          visibleEnemies: enemies.map((u) => ({
            id: u.id,
            seat: u.seat,
            cls: u.cls,
            x: u.x,
            y: u.y,
            hp: u.hp,
            armour: u.armour,
            weapon: u.weapon,
          })),
          items: visibleItems(state, seat, seen).map((item) => ({ ...item })),
          events: eventsFor(state, seat),
          chat: chatFor(state, seat),
        },
        legalTools,
      };
    },
    legalActions(state, seat): LegalActionSpec[] {
      if (canLoadout(state, seat))
        return [
          {
            tool: "match.loadout",
            phase: "loadout",
            description: `Choose ${TEAM_SIZE} classes (${CLASS_IDS.join(", ")}), total cost <= ${TEAM_BUDGET}; duplicates allowed. Keep catalog: class stats/ability and weapon stats are not repeated. Teams act sequentially in initiative order, rotating each round. Each turn resolves first moves, pickups/self-abilities, attacks/blasts/heals and deaths, then second moves. Storm and eliminations follow the last team. Movement: 8 directions, up one level costs 2, other steps 1; walls or height differences >1 block. Use only visible tiles; pass through allies but end on a free tile. Pickups take the item at the first-leg destination. The second leg uses the points left by the first. Attacks require a shots target; unseen blockers can still make them miss. Ready abilities: grenade uses at within catalog range, volley uses a shots target, heal targets another own unit (heals within catalog radius), others take no target. Optional chat <= ${CHAT_MAX_LENGTH} chars; read previous rounds' chat only after scoring a kill.`,
            jsonSchema: LOADOUT_INPUT_SCHEMA,
          },
        ];
      if (canOrder(state, seat))
        return [
          {
            tool: "match.orders",
            phase: "orders",
            description:
              "One order/unit: moveTo -> action -> thenTo. Both legs share class move points. reach/shots[target]: {x,y,rows}, digits=cost, dots=forbidden. view.rows: [x,y,terrain,heights] (. open,+ cover,# wall). Ability ready at readyRound; use catalog rules.",
            jsonSchema: ORDERS_INPUT_SCHEMA,
          },
        ];
      return [];
    },
    submit(state, seat, input, tool) {
      const rejected = (reason: string) => ({ accepted: false, reason, state });
      if (tool === "match.loadout") {
        if (!canLoadout(state, seat)) return rejected("Seat cannot choose a loadout now");
        const parsed = loadoutSchema.safeParse(input);
        if (!parsed.success) return rejected("Expected exactly three actor classes");
        if (!isAffordable(parsed.data.actors))
          return rejected(`Roster exceeds the budget of ${TEAM_BUDGET}`);
        return {
          accepted: true,
          reason: "ok",
          committedActionId: `${state.matchId}:loadout:${seat}`,
          state: withChat(
            { ...state, loadouts: { ...state.loadouts, [seat]: [...parsed.data.actors] } },
            seat,
            parsed.data.chat,
          ),
        };
      }
      if (tool === "match.orders") {
        if (!canOrder(state, seat)) return rejected("Seat cannot submit orders now");
        const parsed = ordersSchema.safeParse(input);
        if (!parsed.success) return rejected("Malformed orders");
        const checked = validateOrders(state, seat, parsed.data);
        if (!checked.ok) return rejected(checked.reason);
        return {
          accepted: true,
          reason: "ok",
          committedActionId: `${state.matchId}:round${state.round}:${seat}`,
          state: withChat(
            {
              ...state,
              pending: { seat, orders: structuredClone(parsed.data.orders), paths: checked.paths },
            },
            seat,
            parsed.data.chat,
          ),
        };
      }
      return rejected("Unknown battle royale tool");
    },
    step(state) {
      if (!isReady(state)) return state;
      if (state.phase === "loadout") return spawn(state);
      const resolved = resolveTurn(state);
      return turnsRemain(resolved) ? resolved : endRound(resolved);
    },
    isTerminal: (state) => state.phase === "terminal",
    // Tied teams split the points of the placements they jointly occupy.
    score: (state) =>
      Object.fromEntries(
        state.seats.map((seat) => {
          const placement = state.teams[seat]?.placement;
          if (state.phase !== "terminal" || placement == null) return [seat, 0];
          const tied = state.seats.filter((s) => state.teams[s]?.placement === placement).length;
          const n = state.seats.length;
          let total = 0;
          for (let position = placement; position < placement + tied; position++)
            total += (n - position) / (n - 1);
          return [seat, total / tied];
        }),
      ),
  };
}

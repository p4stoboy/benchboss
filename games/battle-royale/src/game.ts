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
  type AbilityId,
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
import {
  type TileKind,
  chebyshev,
  inBounds,
  key,
  stormDamage,
  zoneCenter,
  zoneRadius,
} from "./map";
import type { Reach } from "./path";
import { resolveRound, snapshot } from "./resolve";
import {
  CHAT_MAX_LENGTH,
  LOADOUT_INPUT_SCHEMA,
  ORDERS_INPUT_SCHEMA,
  loadoutSchema,
  ordersSchema,
} from "./schemas";
import {
  abilityReady,
  aliveSeats,
  continuations,
  initiative,
  isEliminated,
  knownItemAt,
  knownItems,
  maxHp,
  ownUnits,
  plans,
  rememberSightings,
  samePoint,
  unitById,
  visibleEnemies,
  visionOf,
} from "./state";
import type {
  BrState,
  ChatMessage,
  Orders,
  Point,
  RoundEvent,
  SeenItem,
  SeenUnit,
  Unit,
} from "./types";

export const BR_GAME_ID = "battle-royale";
export const MIN_SEATS = 2;
export const MAX_SEATS = 30;
export const BR_DEFAULT_RULES = { maxRounds: 40, tilesPerSeat: 300 };
export const BR_RULES_SCHEMA = {
  type: "object",
  properties: {
    maxRounds: { type: "integer", minimum: 4, maximum: 200 },
    tilesPerSeat: { type: "integer", minimum: 9, maximum: 600 },
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

/** The tiles a team can see now, as one string per row from the box origin; `?` is unseen. */
export interface BrView {
  x: number;
  y: number;
  terrain: string[];
  heights: string[];
}

export interface BrObservation {
  matchId: string;
  phase: string;
  seat: SeatId;
  publicState: {
    round: number;
    maxRounds: number;
    map: { width: number; height: number };
    zone: {
      center: Point;
      radius: number;
      nextRadius: number;
      stormDamage: number;
      nextStormDamage: number;
    };
    teams: { seat: SeatId; unitsAlive: number; placement: number | null }[];
    initiative: SeatId[];
    /** Sent during the loadout phase only; agents keep it. */
    catalog?: BrCatalog;
  };
  privateState: {
    /** True once this seat has submitted for the current phase; everything below is then empty. */
    committed: boolean;
    loadout: ClassId[] | null;
    view: BrView | null;
    units: {
      id: string;
      cls: ClassId;
      x: number;
      y: number;
      hp: number;
      maxHp: number;
      armour: number;
      move: number;
      vision: number;
      weapon: WeaponId;
      range: number;
      damage: number;
      ability: { id: AbilityId; ready: boolean; readyRound: number };
      hiddenUntil: number;
      /**
       * Move cost to every tile the unit may end its first leg on, as a digit per tile in row
       * strings from the box origin; `.` is unreachable this round. Its own tile is `0`.
       */
      reach: { x: number; y: number; rows: string[] };
      /** Destinations with at least one attackable enemy, keyed `x,y`. */
      shots: Record<string, string[]>;
    }[];
    visibleEnemies: {
      id: string;
      seat: SeatId;
      cls: ClassId;
      x: number;
      y: number;
      hp: number;
      maxHp: number;
      armour: number;
      weapon: WeaponId;
    }[];
    lastSeen: SeenUnit[];
    /** Items on tiles this team has seen, as of the round it last saw each tile. */
    items: SeenItem[];
    lastRound: RoundEvent[];
    /** Previous rounds' lines, only in the turn after this seat scored a kill. */
    chat: ChatMessage[];
  };
  legalTools: string[];
}

const canLoadout = (state: BrState, seat: SeatId): boolean =>
  state.phase === "loadout" && !isEliminated(state, seat) && state.loadouts[seat] === undefined;
const canOrder = (state: BrState, seat: SeatId): boolean =>
  state.phase === "orders" && !isEliminated(state, seat) && state.orders[seat] === undefined;

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
export function costGrid(reaches: readonly Reach[]): { x: number; y: number; rows: string[] } {
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

/** Bounding box of the seat's visible tiles rendered as row strings; null when nothing is seen. */
export function viewFor(state: BrState, seen: ReadonlySet<string>): BrView | null {
  if (seen.size === 0) return null;
  let x0 = state.map.width;
  let y0 = state.map.height;
  let x1 = -1;
  let y1 = -1;
  for (const tile of seen) {
    const [x, y] = tile.split(",").map(Number) as [number, number];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const terrain: string[] = [];
  const heights: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let t = "";
    let h = "";
    for (let x = x0; x <= x1; x++) {
      const tile = state.map.tiles[y]?.[x];
      const visible = tile !== undefined && seen.has(key({ x, y }));
      t += visible ? TERRAIN_CHAR[tile.kind] : "?";
      h += visible ? String(tile.h) : "?";
    }
    terrain.push(t);
    heights.push(h);
  }
  return { x: x0, y: y0, terrain, heights };
}

const withChat = (state: BrState, seat: SeatId, text: string | undefined): BrState =>
  text === undefined
    ? state
    : { ...state, chat: [...state.chat, { round: state.round, seat, text }] };

/**
 * Events a seat may learn about: its own units, or positions its units can see now. A fizzle
 * against an enemy reads only "missed": the true reason would tell where the target went or what
 * stood between.
 */
export function eventsFor(state: BrState, seat: SeatId): RoundEvent[] {
  const seen = visionOf(state, seat);
  const own = (id: string): boolean => unitById(state, id)?.seat === seat;
  const visible = (p: Point): boolean => seen.has(key(p));
  const disclosed = state.lastRound.map((event) =>
    event.kind === "fizzle" && event.target !== "" && !own(event.target)
      ? { ...event, reason: "missed" }
      : event,
  );
  return disclosed.filter((event) => {
    switch (event.kind) {
      case "move":
        return own(event.unit) || visible(event.to);
      case "attack":
      case "heal":
        return own(event.unit) || own(event.target) || (visible(event.from) && visible(event.at));
      case "fizzle":
        return own(event.unit);
      case "ability":
        return own(event.unit) || visible(event.from);
      case "blast":
        return own(event.unit) || own(event.target) || visible(event.at);
      case "pickup":
      case "storm":
      case "death":
        return own(event.unit) || visible(event.at);
      case "eliminated":
        return true;
    }
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
  return rememberSightings({ ...spawned, history: [snapshot(spawned, 0, [])] });
}

export function isReady(state: BrState): boolean {
  if (state.phase === "loadout")
    return aliveSeats(state).every((seat) => state.loadouts[seat] !== undefined);
  if (state.phase === "orders")
    return aliveSeats(state).every((seat) => state.orders[seat] !== undefined);
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
      if (!knownItemAt(state, seat, reach))
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
        round: 0,
        loadouts: {},
        units: [],
        items: scatterLoot(createRng(seed).fork("loot"), map),
        reveals: [],
        itemMemory: {},
        orders: {},
        paths: {},
        teams,
        recentKills: {},
        explored: {},
        memory: {},
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
        (state.phase === "orders" && state.orders[seat] !== undefined) ||
        state.phase === "terminal";
      const center = zoneCenter(state.map);
      const round = Math.max(1, state.round);
      const publicState: BrObservation["publicState"] = {
        round: state.round,
        maxRounds: state.rules.maxRounds,
        map: { width: state.map.width, height: state.map.height },
        zone: {
          center,
          radius: zoneRadius(state.map, state.rules.maxRounds, round),
          nextRadius: zoneRadius(state.map, state.rules.maxRounds, round + 1),
          stormDamage: stormDamage(round),
          nextStormDamage: stormDamage(round + 1),
        },
        teams: state.seats.map((s) => ({
          seat: s,
          unitsAlive: ownUnits(state, s).length,
          placement: state.teams[s]?.placement ?? null,
        })),
        initiative: state.phase === "orders" ? initiative(state) : [],
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
      if (committed)
        return {
          matchId: state.matchId,
          phase: state.phase,
          seat,
          publicState,
          privateState: {
            committed: true,
            loadout,
            view: null,
            units: [],
            visibleEnemies: [],
            lastSeen: [],
            items: [],
            lastRound: [],
            chat: [],
          },
          legalTools,
        };
      const seen = visionOf(state, seat);
      const enemies = visibleEnemies(state, seat, seen);
      const remembered = Object.values(state.memory[seat] ?? {}).filter(
        (entry) => !enemies.some((enemy) => enemy.id === entry.id),
      );
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
            maxHp: maxHp(unit),
            armour: unit.armour,
            move: CLASSES[unit.cls].move,
            vision: CLASSES[unit.cls].vision,
            weapon: unit.weapon,
            range: WEAPONS[unit.weapon].range,
            damage: WEAPONS[unit.weapon].damage,
            ability: {
              id: CLASSES[unit.cls].ability,
              ready: abilityReady(state, unit),
              readyRound: unit.readyRound,
            },
            hiddenUntil: unit.hiddenUntil,
            reach: costGrid(reaches),
            shots: Object.fromEntries(
              reaches.filter((r) => r.targets.length).map((r) => [key(r), [...r.targets]]),
            ),
          })),
          visibleEnemies: enemies.map((u) => ({
            id: u.id,
            seat: u.seat,
            cls: u.cls,
            x: u.x,
            y: u.y,
            hp: u.hp,
            maxHp: maxHp(u),
            armour: u.armour,
            weapon: u.weapon,
          })),
          lastSeen: remembered.map((entry) => ({ ...entry })),
          items: knownItems(state, seat).map((item) => ({ ...item })),
          lastRound: eventsFor(state, seat),
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
            description: `Choose ${TEAM_SIZE} actor classes (${CLASS_IDS.join(", ")}) whose costs total at most ${TEAM_BUDGET}. Duplicates are allowed. Keep the catalog and map size from this observation; later turns show only what your units can see. Optional chat (up to ${CHAT_MAX_LENGTH} characters) posts to the public all-chat; you read it only in the turn after you score a kill.`,
            jsonSchema: LOADOUT_INPUT_SCHEMA,
          },
        ];
      if (canOrder(state, seat))
        return [
          {
            tool: "match.orders",
            phase: "orders",
            description: `Order your living units: an optional moveTo (a digit tile in the unit's reach grid; the digit is its move cost), one optional action there: attack (a target in shots for that destination), ability (when ready; grenade takes at, volley and heal take target, others nothing), pickup (an item you have seen on the destination) or hold, and an optional thenTo walked afterwards with the points left (move minus the digit; a step up one level costs 2, any other step 1; only tiles you can see now). Orders resolve together: first legs in initiative order, pickups and self-abilities, attacks, blasts and heals at once, second legs, then the storm. Optional chat (up to ${CHAT_MAX_LENGTH} characters).`,
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
              orders: { ...state.orders, [seat]: { orders: structuredClone(parsed.data.orders) } },
              paths: { ...state.paths, [seat]: checked.paths },
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
      return state.phase === "loadout" ? spawn(state) : resolveRound(state);
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

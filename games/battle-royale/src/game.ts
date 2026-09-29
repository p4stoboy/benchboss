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
import { itemAt, scatterLoot } from "./loot";
import {
  type TileKind,
  chebyshev,
  heightGrid,
  inBounds,
  key,
  stormDamage,
  terrainGrid,
  zoneCenter,
  zoneRadius,
} from "./map";
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
  initiative,
  isEliminated,
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
  Item,
  Orders,
  Point,
  RoundEvent,
  SeenUnit,
  Unit,
} from "./types";

export const BR_GAME_ID = "battle-royale";
export const MIN_SEATS = 2;
export const MAX_SEATS = 30;
export const BR_DEFAULT_RULES = { maxRounds: 40, tilesPerSeat: 150 };
export const BR_RULES_SCHEMA = {
  type: "object",
  properties: {
    maxRounds: { type: "integer", minimum: 4, maximum: 200 },
    tilesPerSeat: { type: "integer", minimum: 9, maximum: 300 },
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

export interface BrObservation {
  matchId: string;
  phase: string;
  seat: SeatId;
  publicState: {
    round: number;
    maxRounds: number;
    /** Row-major grids: heights[y][x], terrain[y][x]. */
    map: { width: number; height: number; heights: number[][]; terrain: TileKind[][] };
    zone: {
      center: Point;
      radius: number;
      nextRadius: number;
      stormDamage: number;
      nextStormDamage: number;
    };
    teams: { seat: SeatId; unitsAlive: number; placement: number | null }[];
    initiative: SeatId[];
    classes: typeof CLASSES;
    weapons: typeof WEAPONS;
    abilities: typeof ABILITIES;
    maxArmour: number;
    budget: number;
    teamSize: number;
    /** Every item still on the ground; loot positions are common knowledge. */
    items: Item[];
    chat: ChatMessage[];
  };
  privateState: {
    loadout: ClassId[] | null;
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
      reachable: { x: number; y: number; cost: number; targets: string[] }[];
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
    lastRound: RoundEvent[];
  };
  legalTools: string[];
}

const canLoadout = (state: BrState, seat: SeatId): boolean =>
  state.phase === "loadout" && !isEliminated(state, seat) && state.loadouts[seat] === undefined;
const canOrder = (state: BrState, seat: SeatId): boolean =>
  state.phase === "orders" && !isEliminated(state, seat) && state.orders[seat] === undefined;

export const recentChat = (state: BrState): ChatMessage[] =>
  state.chat.slice(-CHAT_WINDOW).map((line) => ({ ...line }));

const withChat = (state: BrState, seat: SeatId, text: string | undefined): BrState =>
  text === undefined
    ? state
    : { ...state, chat: [...state.chat, { round: state.round, seat, text }] };

/** Events a seat may learn about: its own units, or positions its units can see now. */
export function eventsFor(state: BrState, seat: SeatId): RoundEvent[] {
  const seen = visionOf(state, seat);
  const own = (id: string): boolean => unitById(state, id)?.seat === seat;
  const visible = (p: Point): boolean => seen.has(key(p));
  return state.lastRound.filter((event) => {
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
): { ok: true; paths: Record<string, Point[]> } | { ok: false; reason: string } {
  const planned = plans(state, seat);
  const enemies = new Set(visibleEnemies(state, seat).map((u) => u.id));
  const paths: Record<string, Point[]> = {};
  const used = new Set<string>();
  const fail = (reason: string) => ({ ok: false as const, reason });
  for (const order of orders.orders) {
    if (used.has(order.unit)) return fail(`duplicate order for ${order.unit}`);
    used.add(order.unit);
    const plan = planned.find((p) => p.unit.id === order.unit);
    if (!plan) return fail(`${order.unit} is not one of your living units`);
    const destination = order.moveTo ?? plan.unit;
    const reach = plan.reaches.find((r) => samePoint(r, destination));
    if (!reach) return fail(`${order.unit} cannot reach ${destination.x},${destination.y}`);
    paths[order.unit] = reach.path;
    const action = order.action;
    if (!action || action.kind === "hold") continue;
    if (action.kind === "attack") {
      if (!enemies.has(action.target)) return fail(`${action.target} is not a visible enemy`);
      if (!reach.targets.includes(action.target))
        return fail(`${order.unit} cannot attack ${action.target} from ${reach.x},${reach.y}`);
      continue;
    }
    if (action.kind === "pickup") {
      if (!itemAt(state.items, reach)) return fail(`nothing to pick up at ${reach.x},${reach.y}`);
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
      if (!enemies.has(action.target)) return fail(`${action.target} is not a visible enemy`);
      if (!reach.targets.includes(action.target))
        return fail(`${order.unit} cannot attack ${action.target} from ${reach.x},${reach.y}`);
      continue;
    }
    const ally = unitById(state, action.target);
    if (!ally?.alive || ally.seat !== seat || ally.id === order.unit)
      return fail(`${action.target} is not another living unit of yours`);
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
        orders: {},
        paths: {},
        teams,
        memory: {},
        lastRound: [],
        history: [],
        chat: [],
        cause: null,
      };
    },
    observe(state, seat): BrObservation {
      const seen = visionOf(state, seat);
      const enemies = visibleEnemies(state, seat, seen);
      const remembered = Object.values(state.memory[seat] ?? {}).filter(
        (entry) => !enemies.some((enemy) => enemy.id === entry.id),
      );
      const planned =
        state.phase === "orders" && !isEliminated(state, seat) ? plans(state, seat) : [];
      const center = zoneCenter(state.map);
      return {
        matchId: state.matchId,
        phase: state.phase,
        seat,
        publicState: {
          round: state.round,
          maxRounds: state.rules.maxRounds,
          map: {
            width: state.map.width,
            height: state.map.height,
            heights: heightGrid(state.map),
            terrain: terrainGrid(state.map),
          },
          zone: {
            center,
            radius: zoneRadius(state.map, state.rules.maxRounds, Math.max(1, state.round)),
            nextRadius: zoneRadius(state.map, state.rules.maxRounds, Math.max(1, state.round) + 1),
            stormDamage: stormDamage(Math.max(1, state.round)),
            nextStormDamage: stormDamage(Math.max(1, state.round) + 1),
          },
          teams: state.seats.map((s) => ({
            seat: s,
            unitsAlive: ownUnits(state, s).length,
            placement: state.teams[s]?.placement ?? null,
          })),
          initiative: state.phase === "orders" ? initiative(state) : [],
          classes: CLASSES,
          weapons: WEAPONS,
          abilities: ABILITIES,
          maxArmour: MAX_ARMOUR,
          budget: TEAM_BUDGET,
          teamSize: TEAM_SIZE,
          items: state.items.map((item) => ({ ...item })),
          chat: recentChat(state),
        },
        privateState: {
          loadout: state.loadouts[seat] ? [...(state.loadouts[seat] as ClassId[])] : null,
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
            reachable: reaches.map((r) => ({
              x: r.x,
              y: r.y,
              cost: r.cost,
              targets: [...r.targets],
            })),
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
          lastRound: eventsFor(state, seat),
        },
        legalTools: canLoadout(state, seat)
          ? [...BR_PHASE_TOOLS.loadout]
          : canOrder(state, seat)
            ? [...BR_PHASE_TOOLS.orders]
            : [],
      };
    },
    legalActions(state, seat): LegalActionSpec[] {
      if (canLoadout(state, seat))
        return [
          {
            tool: "match.loadout",
            phase: "loadout",
            description: `Choose ${TEAM_SIZE} actor classes (${CLASS_IDS.join(", ")}) whose costs total at most ${TEAM_BUDGET}. Duplicates are allowed. Optional chat (up to ${CHAT_MAX_LENGTH} characters) posts to the public all-chat every team and spectator can read.`,
            jsonSchema: LOADOUT_INPUT_SCHEMA,
          },
        ];
      if (canOrder(state, seat))
        return [
          {
            tool: "match.orders",
            phase: "orders",
            description: `Order your living units for this round: an optional moveTo from the unit's reachable list and one optional action: attack (a target listed for that destination), ability (the unit's class ability when ready: recon, brace and camo take nothing; grenade takes a tile "at" within ${ABILITIES.grenade.range}; volley takes a listed target; heal takes another of your units that will be adjacent), pickup (the item on the destination tile) or hold. Omitted units hold. All teams' orders resolve together: movement in initiative order, then pickups and self-abilities, then attacks, blasts and heals simultaneously, then storm damage outside the zone. Optional chat (up to ${CHAT_MAX_LENGTH} characters) posts to the public all-chat every team and spectator can read.`,
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

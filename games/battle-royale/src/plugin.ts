import type { SeatId } from "@benchboss/core";
import type {
  GameResult,
  HostEvent,
  Participation,
  ResourceAllowances,
  SpectatorView,
  TimingPolicy,
} from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";
import { CLASS_IDS, TEAM_BUDGET, TEAM_SIZE } from "./classes";
import { safeDefault } from "./defaults";
import {
  BR_DEFAULT_RULES,
  BR_GAME_ID,
  BR_PHASE_TOOLS,
  BR_RULES_SCHEMA,
  MAX_SEATS,
  MIN_SEATS,
  canOrder,
  isReady,
  makeBattleRoyale,
  recentChat,
} from "./game";
import { itemLabel } from "./loot";
import { TILE_KINDS, stormDamage, tileCode, zoneRadius } from "./map";
import { forfeitSeats } from "./resolve";
import { aliveSeats, isEliminated, ownUnits, turnOrder, unitById, visionOf } from "./state";
import type { BrState, Point, RoundEvent } from "./types";

// The runtime spends an action on every call, rejected or not, so the phase allowance must
// cover the accepted submission plus both semantic retries. The game itself accepts one
// loadout or one orders submission per seat per phase.
const RESOURCES = {
  actions: { amount: 3, reset: "phase", visibility: "public" },
  retries: { amount: 2, reset: "decision", visibility: "private" },
} satisfies ResourceAllowances;
const TIMING = {
  playerTotalMs: null,
  decisionLimitMs: 60_000,
  phaseLimits: {},
  clockVisibility: "public",
} satisfies TimingPolicy;
const METERING = {
  action: { resource: "actions", cost: 1 },
  invalidAction: { resource: "retries", cost: 1 },
};

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

export function brResult(state: BrState): GameResult | null {
  if (state.phase !== "terminal") return null;
  const winners = state.seats.filter((seat) => state.teams[seat]?.placement === 1);
  return {
    cause: { kind: state.cause ?? "rules" },
    summary:
      winners.length === 1
        ? `${winners[0]} wins after ${state.round - 1} rounds`
        : `${winners.join(", ")} share first place after ${state.round - 1} rounds`,
    seats: state.seats.map((seat) => {
      const record = state.teams[seat];
      const placement = record?.placement ?? state.seats.length;
      return {
        seat,
        outcome: placement !== 1 ? "loss" : winners.length === 1 ? "win" : "draw",
        placement,
        team: seat,
        metrics: [
          { label: "Placement", value: placement },
          { label: "Kills", value: record?.kills ?? 0 },
          { label: "Damage dealt", value: record?.damageDealt ?? 0 },
          { label: "Rounds survived", value: record?.eliminatedRound ?? state.round - 1 },
        ],
      };
    }),
  };
}

const EVENT_COLUMNS = [
  "Entry",
  "Kind",
  "Unit",
  "Target",
  "Seat",
  "From x",
  "From y",
  "At x",
  "At y",
  "Value",
  "Note",
  "Path",
];

/**
 * One scalar row per event; blanks mean not applicable. Paths are "x,y" tiles separated by
 * spaces. Notes carry the move block flag, fizzle reason, ability id or picked-up item label;
 * a weapon pickup's value is the weapon left behind.
 */
function eventRow(entry: number, event: RoundEvent): (string | number)[] {
  const cells = (
    kind: string,
    unit: string,
    target: string,
    seat: string,
    from: Point | null,
    at: Point | null,
    value: string | number,
    note: string,
    path: string,
  ): (string | number)[] => [
    entry,
    kind,
    unit,
    target,
    seat,
    from?.x ?? "",
    from?.y ?? "",
    at?.x ?? "",
    at?.y ?? "",
    value,
    note,
    path,
  ];
  switch (event.kind) {
    case "move":
      return cells(
        "move",
        event.unit,
        "",
        "",
        event.from,
        event.to,
        "",
        event.blocked ? "blocked" : "",
        event.path.map((p) => `${p.x},${p.y}`).join(" "),
      );
    case "attack":
      return cells(
        "attack",
        event.unit,
        event.target,
        "",
        event.from,
        event.at,
        event.damage,
        "",
        "",
      );
    case "heal":
      return cells(
        "heal",
        event.unit,
        event.target,
        "",
        event.from,
        event.at,
        event.amount,
        "",
        "",
      );
    case "fizzle":
      return cells("fizzle", event.unit, event.target, "", null, null, "", event.reason, "");
    case "ability":
      return cells(
        "ability",
        event.unit,
        event.target ?? "",
        "",
        event.from,
        event.at ?? null,
        "",
        event.ability,
        "",
      );
    case "blast":
      return cells("blast", event.unit, event.target, "", null, event.at, event.damage, "", "");
    case "pickup":
      return cells(
        "pickup",
        event.unit,
        "",
        "",
        null,
        event.at,
        event.dropped ?? "",
        event.item === "weapon" ? `weapon:${event.weapon}` : event.item,
        "",
      );
    case "storm":
      return cells("storm", event.unit, "", "", null, event.at, event.damage, "", "");
    case "death":
      return cells("death", event.unit, "", "", null, event.at, "", "", "");
    case "eliminated":
      return cells("eliminated", "", "", event.seat, null, null, event.placement, "", "");
    case "turn":
      return cells("turn", "", "", event.seat, null, null, "", "", "");
  }
}

interface HistoryTitles {
  units: string;
  loot: string;
  events: string;
}

/** The terminal history tables: loadouts, rounds and per-entry units, loot and events. */
function historyBlocks(state: BrState, titles: HistoryTitles): SpectatorView["blocks"] {
  return [
    {
      kind: "table",
      title: "Loadouts",
      columns: ["Seat", "Actors"],
      rows: state.seats.map((seat) => [seat, (state.loadouts[seat] ?? []).join(", ")]),
    },
    {
      kind: "table",
      title: "Rounds",
      columns: ["Entry", "Round", "Zone radius", "Storm damage"],
      rows: state.history.map((entry, i) => [i, entry.round, entry.zoneRadius, entry.stormDamage]),
    },
    {
      kind: "table",
      title: titles.units,
      columns: [
        "Entry",
        "Unit",
        "Seat",
        "Class",
        "X",
        "Y",
        "HP",
        "Armour",
        "Weapon",
        "Ready round",
        "Hidden until",
      ],
      rows: state.history.flatMap((entry, i) =>
        entry.units.map((u) => {
          const unit = unitById(state, u.id);
          return [
            i,
            u.id,
            unit?.seat ?? "",
            unit?.cls ?? "",
            u.x,
            u.y,
            u.hp,
            u.armour,
            u.weapon,
            u.readyRound,
            u.hiddenUntil,
          ];
        }),
      ),
    },
    {
      kind: "table",
      title: titles.loot,
      columns: ["Entry", "X", "Y", "Item"],
      rows: state.history.flatMap((entry, i) =>
        entry.items.map((item) => [i, item.x, item.y, itemLabel(item)]),
      ),
    },
    {
      kind: "table",
      title: titles.events,
      columns: EVENT_COLUMNS,
      rows: state.history.flatMap((entry, i) => entry.events.map((event) => eventRow(i, event))),
    },
  ];
}

/**
 * Live frames carry the explored map as one integer per tile (`-1` unexplored, else
 * `tileCode` under the `Terrain kinds` legend), counts, the round's turn order with each
 * seat's standing, eliminations and chat only; positions, loot, rosters and the unexplored
 * map appear at terminal.
 */
export function brPublicView(state: BrState): SpectatorView {
  const result = brResult(state);
  const round = Math.max(1, state.round);
  const revealed = (x: number, y: number): boolean =>
    state.phase === "terminal" || state.explored[`${x},${y}`] === true;
  const mapRows = state.map.tiles.map((row, y) =>
    row.map((tile, x) => (revealed(x, y) ? tileCode(tile) : -1)),
  );
  const eliminations = state.seats
    .filter((seat) => isEliminated(state, seat))
    .sort((a, b) => (state.teams[b]?.placement ?? 0) - (state.teams[a]?.placement ?? 0))
    .map((seat) => {
      const record = state.teams[seat];
      return `Round ${record?.eliminatedRound ?? "-"}: ${seat} out (${ordinal(record?.placement ?? 0)})`;
    });
  const columns = Array.from({ length: state.map.width }, (_, x) => String(x));
  const standing = new Map(turnOrder(state).map((t) => [t.seat, t.status]));
  const blocks: SpectatorView["blocks"] = [
    {
      kind: "participants",
      title: "Teams",
      seats: state.seats.map((seat) => {
        const record = state.teams[seat];
        const status = standing.get(seat);
        return {
          seat,
          status:
            record?.placement !== null && record?.placement !== undefined
              ? `${ordinal(record.placement)}${record.eliminatedRound !== null ? ` (out round ${record.eliminatedRound})` : ""}`
              : state.phase === "loadout"
                ? state.loadouts[seat]
                  ? "ready"
                  : "choosing loadout"
                : `${ownUnits(state, seat).length} units${status ? `, ${status}` : ""}`,
        };
      }),
    },
    {
      kind: "metrics",
      title: "Round",
      values: [
        { label: "Round", value: state.round },
        { label: "Teams alive", value: aliveSeats(state).length },
        { label: "Zone radius", value: zoneRadius(state.map, state.rules.maxRounds, round) },
        { label: "Storm damage", value: stormDamage(round) },
      ],
    },
    {
      kind: "list",
      title: "Turn order",
      items: turnOrder(state).map((t) => `${t.seat} ${t.status}`),
    },
    { kind: "list", title: "Terrain kinds", items: [...TILE_KINDS] },
    { kind: "table", title: "Map", columns, rows: mapRows },
    { kind: "list", title: "Eliminations", items: eliminations },
    {
      kind: "list",
      title: "Chat",
      items: (state.phase === "terminal" ? state.chat : recentChat(state)).map(
        (line) => `[r${line.round}] ${line.seat}: ${line.text}`,
      ),
    },
  ];
  if (state.phase === "terminal")
    blocks.push(...historyBlocks(state, { units: "Units", loot: "Loot", events: "Events" }));
  return {
    version: 1,
    progress: {
      phase: state.phase,
      label:
        result?.summary ??
        (state.phase === "loadout" ? "Choosing loadouts" : `Round ${state.round}`),
      current: state.round,
      total: state.rules.maxRounds,
    },
    blocks,
    result,
  };
}

const orderRows = (state: BrState): (string | number)[][] =>
  state.turns.flatMap(({ seat, orders }) =>
    orders.map((o) => [
      seat,
      o.unit,
      o.moveTo ? `${o.moveTo.x},${o.moveTo.y}` : "",
      o.thenTo ? `${o.thenTo.x},${o.thenTo.y}` : "",
      o.action?.kind ?? "hold",
      o.action && "target" in o.action ? (o.action.target ?? "") : "",
      o.action && "at" in o.action && o.action.at ? `${o.action.at.x},${o.action.at.y}` : "",
    ]),
  );

const visionRows = (state: BrState): (string | number)[][] =>
  aliveSeats(state).flatMap((seat) => {
    const seen = visionOf(state, seat);
    return state.map.tiles.map((row, y) => [
      seat,
      y,
      row.map((_, x) => (seen.has(`${x},${y}`) ? "#" : ".")).join(""),
    ]);
  });

/**
 * Complete-info projection, every frame: the whole map, every living unit (camouflaged ones
 * too), every item, the orders of every turn resolved so far this round, each living team's
 * vision, active recon discs and the events of the previous round and this one. Nothing is
 * hidden; the platform gates who reads it. At terminal the public history tables follow, so the
 * two terminal frames are at parity.
 */
export function brFullView(state: BrState): SpectatorView {
  const base = brPublicView(state);
  const keep = (title: string): SpectatorView["blocks"][number] => {
    const block = base.blocks.find((b) => b.title === title);
    if (!block) throw Error(`public view lacks ${title}`);
    return block;
  };
  const columns = Array.from({ length: state.map.width }, (_, x) => String(x));
  // The previous round sits in the last history entry; this round's events will form the next.
  const entry = state.history.length;
  return {
    ...base,
    blocks: [
      keep("Teams"),
      keep("Round"),
      keep("Turn order"),
      {
        kind: "table",
        title: "Scores",
        columns: ["Seat", "Units", "Kills", "Damage dealt", "Placement"],
        rows: state.seats.map((seat) => [
          seat,
          ownUnits(state, seat).length,
          state.teams[seat]?.kills ?? 0,
          state.teams[seat]?.damageDealt ?? 0,
          state.teams[seat]?.placement ?? "",
        ]),
      },
      { kind: "list", title: "Terrain kinds", items: [...TILE_KINDS] },
      {
        kind: "table",
        title: "Map",
        columns,
        rows: state.map.tiles.map((row) => row.map(tileCode)),
      },
      {
        kind: "table",
        title: "Units",
        columns: [
          "Unit",
          "Seat",
          "Class",
          "X",
          "Y",
          "HP",
          "Armour",
          "Weapon",
          "Ready round",
          "Hidden until",
        ],
        rows: state.units
          .filter((u) => u.alive)
          .map((u) => [
            u.id,
            u.seat,
            u.cls,
            u.x,
            u.y,
            u.hp,
            u.armour,
            u.weapon,
            u.readyRound,
            u.hiddenUntil,
          ]),
      },
      {
        kind: "table",
        title: "Loot",
        columns: ["X", "Y", "Item"],
        rows: state.items.map((item) => [item.x, item.y, itemLabel(item)]),
      },
      {
        kind: "table",
        title: "Orders",
        columns: ["Seat", "Unit", "Move to", "Then to", "Action", "Target", "At"],
        rows: orderRows(state),
      },
      { kind: "table", title: "Vision", columns: ["Seat", "Y", "Row"], rows: visionRows(state) },
      {
        kind: "table",
        title: "Recon",
        columns: ["Seat", "X", "Y", "Radius", "Until round"],
        rows: state.reveals
          .filter((r) => r.untilRound >= state.round)
          .map((r) => [r.seat, r.center.x, r.center.y, r.radius, r.untilRound]),
      },
      {
        kind: "table",
        title: "Events",
        columns: EVENT_COLUMNS,
        rows: [
          ...state.lastRound.map((event) => eventRow(entry - 1, event)),
          ...state.events.map((event) => eventRow(entry, event)),
        ],
      },
      keep("Eliminations"),
      {
        kind: "list",
        title: "Chat",
        items: state.chat.map((line) => `[r${line.round}] ${line.seat}: ${line.text}`),
      },
      ...(state.phase === "terminal"
        ? historyBlocks(state, {
            units: "Units by entry",
            loot: "Loot by entry",
            events: "Events by entry",
          })
        : []),
    ],
  };
}

export const plugin = {
  id: BR_GAME_ID,
  manifest: {
    protocolVersion: 1,
    id: BR_GAME_ID,
    revision: "3.0.0",
    title: "Battle Royale",
    description:
      "Teams of three armed actors with class abilities fight over loot on a fogged heightmap; one team acts at a time in rotating initiative, a closing storm and last team standing.",
    rulesSource: "games/battle-royale/README.md",
    seatCounts: Array.from({ length: MAX_SEATS - MIN_SEATS + 1 }, (_, i) => MIN_SEATS + i),
    defaultSeats: 4,
    rulesSchema: BR_RULES_SCHEMA,
    defaultRules: BR_DEFAULT_RULES,
    defaultTiming: TIMING,
    defaultResources: RESOURCES,
    defaultMetering: METERING,
    roundStructure: [
      {
        phase: "loadout",
        what: `Every team picks ${TEAM_SIZE} actor classes from ${CLASS_IDS.join("/")} within a budget of ${TEAM_BUDGET} points.`,
      },
      {
        phase: "orders",
        what: "Teams act one at a time in rotating initiative. The acting team submits one order per unit (a move plus an attack, class ability, loot pickup or hold) and its orders resolve at once: movement, pickups and self-abilities, attacks, blasts and heals with immediate damage, then second legs. The next team observes the result before it acts. Once every team has acted the storm damages units outside the zone and empty teams are eliminated together. Repeats until one team remains or the round cap.",
      },
    ],
    winConditions: [
      "Be the last team with a living unit. Teams eliminated in the same round share a placement.",
      "At the round cap, survivors rank by living units, then total hit points, then damage dealt.",
    ],
    safeDefaults: [
      "A missing loadout fields three grunts. Missing orders on a team's turn move every unit toward the safe zone without attacking. Player time exhaustion eliminates the team.",
    ],
    disclosure: "full-after-terminal",
  },
  makeGame: makeBattleRoyale,
  publicView: brPublicView,
  fullView: brFullView,
  phaseToTools: BR_PHASE_TOOLS,
  currentPhase: (state: BrState) => state.phase,
  isReady,
  safeDefault,
  defaultSeats: 4,
  defaultRules: BR_DEFAULT_RULES,
  participation: (state: BrState, seat: SeatId): Participation => {
    if (isEliminated(state, seat)) return { status: "finished", reason: "eliminated" };
    const acting =
      (state.phase === "loadout" && state.loadouts[seat] === undefined) || canOrder(state, seat);
    return { status: acting ? "acting" : "waiting" };
  },
  onHostEvent: (state: BrState, event: HostEvent): BrState =>
    event.kind === "player_time_exhausted"
      ? forfeitSeats(state, event.seats as SeatId[], event.kind)
      : state,
} satisfies GamePlugin<BrState>;

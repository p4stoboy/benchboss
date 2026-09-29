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
  isReady,
  makeBattleRoyale,
  recentChat,
} from "./game";
import { heightRows, stormDamage, terrainRows, zoneRadius } from "./map";
import { forfeitSeats } from "./resolve";
import { aliveSeats, isEliminated, ownUnits } from "./state";
import type { BrState } from "./types";

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

/** Live frames carry terrain, counts, eliminations and chat only; positions and rosters appear at terminal. */
export function brPublicView(state: BrState): SpectatorView {
  const result = brResult(state);
  const round = Math.max(1, state.round);
  const eliminations = state.seats
    .filter((seat) => isEliminated(state, seat))
    .sort((a, b) => (state.teams[b]?.placement ?? 0) - (state.teams[a]?.placement ?? 0))
    .map((seat) => {
      const record = state.teams[seat];
      return `Round ${record?.eliminatedRound ?? "-"}: ${seat} out (${ordinal(record?.placement ?? 0)})`;
    });
  const blocks: SpectatorView["blocks"] = [
    {
      kind: "participants",
      title: "Teams",
      seats: state.seats.map((seat) => {
        const record = state.teams[seat];
        return {
          seat,
          status:
            record?.placement !== null && record?.placement !== undefined
              ? `${ordinal(record.placement)}${record.eliminatedRound !== null ? ` (out round ${record.eliminatedRound})` : ""}`
              : state.phase === "loadout"
                ? state.loadouts[seat]
                  ? "ready"
                  : "choosing loadout"
                : `${ownUnits(state, seat).length} units${state.orders[seat] ? ", orders in" : ""}`,
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
      kind: "text",
      title: `Heights (${state.map.width}x${state.map.height})`,
      text: heightRows(state.map).join("\n"),
    },
    {
      kind: "text",
      title: "Terrain (. open, + cover, # wall)",
      text: terrainRows(state.map).join("\n"),
    },
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
    blocks.push(
      {
        kind: "table",
        title: "Loadouts",
        columns: ["Seat", "Actors"],
        rows: state.seats.map((seat) => [seat, (state.loadouts[seat] ?? []).join(", ")]),
      },
      {
        kind: "text",
        title: "History (round: unit@x,y:hp ...)",
        text: state.history
          .map(
            (snapshot) =>
              `${snapshot.round}: ${snapshot.units.map((u) => `${u.id}@${u.x},${u.y}:${u.hp}`).join(" ")}`,
          )
          .join("\n"),
      },
    );
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

export const plugin = {
  id: BR_GAME_ID,
  manifest: {
    protocolVersion: 1,
    id: BR_GAME_ID,
    revision: "1.0.0",
    title: "Battle Royale",
    description:
      "Teams of three actors fight on a fogged heightmap; simultaneous orders, a closing storm and last team standing.",
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
        what: "Every living team submits one order per unit. Movement resolves in rotating initiative, attacks and heals land simultaneously, then the storm damages units outside the zone. Repeats until one team remains or the round cap.",
      },
    ],
    winConditions: [
      "Be the last team with a living unit. Teams eliminated in the same round share a placement.",
      "At the round cap, survivors rank by living units, then total hit points, then damage dealt.",
    ],
    safeDefaults: [
      "A missing loadout fields three grunts. Missing orders move every unit toward the safe zone without attacking. Player time exhaustion eliminates the team.",
    ],
    disclosure: "full-after-terminal",
  },
  makeGame: makeBattleRoyale,
  publicView: brPublicView,
  phaseToTools: BR_PHASE_TOOLS,
  currentPhase: (state: BrState) => state.phase,
  isReady,
  safeDefault,
  defaultSeats: 4,
  defaultRules: BR_DEFAULT_RULES,
  participation: (state: BrState, seat: SeatId): Participation => {
    if (isEliminated(state, seat)) return { status: "finished", reason: "eliminated" };
    const acting =
      (state.phase === "loadout" && state.loadouts[seat] === undefined) ||
      (state.phase === "orders" && state.orders[seat] === undefined);
    return { status: acting ? "acting" : "waiting" };
  },
  onHostEvent: (state: BrState, event: HostEvent): BrState =>
    event.kind === "player_time_exhausted"
      ? forfeitSeats(state, event.seats as SeatId[], event.kind)
      : state,
} satisfies GamePlugin<BrState>;

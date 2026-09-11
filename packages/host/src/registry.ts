import { isDeepStrictEqual } from "node:util";
import type { MatchConfig, SeatId } from "@benchboss/core";
import {
  type AnyGameManifest,
  type GameRevision,
  LEGACY_RUNTIME_VERSION,
  RUNTIME_VERSION,
  validateMetering,
  validateResources,
  validateSchema,
  validateTimingPolicy,
} from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";

export type GameInfo = AnyGameManifest & {
  manifest: AnyGameManifest;
  id: string;
  seats: number;
  budgets?: MatchConfig["budgets"];
  rules: Record<string, unknown>;
  phases: Record<string, string[]>;
};

export interface GameRegistry {
  has(id: string): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: registry holds heterogeneous game plugins
  get(id: string, revision?: string): GamePlugin<any>;
  resolve(config: MatchConfig): GamePlugin<unknown>;
  seatsFor(id: string): number;
  buildConfig(matchId: string, gameId: string, seats: SeatId[]): MatchConfig;
  list(): GameInfo[];
}

export function createRegistry(
  // biome-ignore lint/suspicious/noExplicitAny: registry holds heterogeneous game plugins
  plugins: GamePlugin<any>[],
  options: { legacyRevisions?: Record<string, string> } = {},
): GameRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by id
  const byId = new Map<string, GamePlugin<any>>();
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by revision
  const revisions = new Map<string, GamePlugin<any>>();
  for (const p of plugins) {
    const m = p.manifest;
    if (!m || m.id !== p.id || ![1, 2].includes(m.protocolVersion))
      throw Error("invalid game manifest");
    if (
      [m.id, m.revision, m.title, m.description, m.rulesSource].some(
        (v) => typeof v !== "string" || !v.trim(),
      ) ||
      !Array.isArray(m.roundStructure) ||
      !Array.isArray(m.winConditions) ||
      !Array.isArray(m.safeDefaults) ||
      m.disclosure !== "full-after-terminal" ||
      !m.defaultRules ||
      !validateSchema(m.rulesSchema, m.defaultRules).ok
    )
      throw Error("invalid game manifest");
    if (
      !Array.isArray(m.seatCounts) ||
      m.seatCounts.length === 0 ||
      m.seatCounts.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      new Set(m.seatCounts).size !== m.seatCounts.length ||
      !m.seatCounts.includes(m.defaultSeats) ||
      m.defaultSeats !== p.defaultSeats ||
      !isDeepStrictEqual(m.defaultRules, p.defaultRules ?? {})
    )
      throw Error("inconsistent game defaults");
    if (m.protocolVersion === 1) {
      if (
        !m.defaultBudgets ||
        !isDeepStrictEqual(m.defaultBudgets, p.defaultBudgets) ||
        Object.values(m.defaultBudgets).some((n) => !Number.isFinite(n) || n < 0)
      )
        throw Error("inconsistent game defaults");
    } else {
      const allowed = new Set([
        "protocolVersion",
        "id",
        "revision",
        "title",
        "description",
        "rulesSource",
        "seatCounts",
        "defaultSeats",
        "rulesSchema",
        "defaultRules",
        "defaultTiming",
        "defaultResources",
        "defaultMetering",
        "roundStructure",
        "winConditions",
        "safeDefaults",
        "disclosure",
      ]);
      if (Object.keys(m).some((key) => !allowed.has(key)))
        throw Error("invalid game manifest fields");
      validatePolicies(m.defaultTiming, m.defaultResources, m.defaultMetering, p.onHostEvent);
    }
    const key = `${p.id}@${m.revision}`;
    if (revisions.has(key)) throw Error(`duplicate game id: ${key}`);
    revisions.set(key, p);
    if (
      m.revision !== options.legacyRevisions?.[p.id] &&
      (byId.get(p.id)?.manifest.protocolVersion ?? 0) <= m.protocolVersion
    )
      byId.set(p.id, p);
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by id
  const require = (id: string, revision?: string): GamePlugin<any> => {
    const p = revision === undefined ? byId.get(id) : revisions.get(`${id}@${revision}`);
    if (!p) throw Error(`unknown game: ${id}`);
    return p;
  };
  return {
    has: (id) => byId.has(id),
    get: require,
    resolve: (config) => {
      const identity = config.identity;
      if (
        identity &&
        (Object.keys(identity).some(
          (key) => !["protocolVersion", "runtimeVersion", "gameId", "revision"].includes(key),
        ) ||
          ![1, 2].includes(identity.protocolVersion) ||
          identity.runtimeVersion !==
            (identity.protocolVersion === 2 ? RUNTIME_VERSION : LEGACY_RUNTIME_VERSION) ||
          identity.gameId !== config.gameId)
      )
        throw Error("unsupported match identity");
      const revision = identity?.revision ?? options.legacyRevisions?.[config.gameId];
      if (!revision) throw Error(`legacy revision not registered: ${config.gameId}`);
      const plugin = require(config.gameId, revision);
      if ((identity?.protocolVersion ?? 1) !== plugin.manifest.protocolVersion)
        throw Error("unsupported match identity");
      validateConfig(plugin.manifest, config, plugin.onHostEvent);
      return plugin;
    },
    seatsFor: (id) => require(id).defaultSeats,
    list: () =>
      [...byId.values()].map((p) =>
        structuredClone({
          manifest: p.manifest,
          ...p.manifest,
          id: p.id,
          seats: p.defaultSeats,
          ...(p.manifest.protocolVersion === 1 ? { budgets: p.manifest.defaultBudgets } : {}),
          rules: p.manifest.defaultRules,
          phases: p.phaseToTools,
        }),
      ),
    buildConfig: (matchId, gameId, seats) => {
      const p = require(gameId);
      const m = p.manifest;
      const common = { matchId, gameId, seats, rules: m.defaultRules };
      const identity = {
        protocolVersion: m.protocolVersion,
        runtimeVersion: m.protocolVersion === 2 ? RUNTIME_VERSION : LEGACY_RUNTIME_VERSION,
        gameId,
        revision: m.revision,
      } satisfies GameRevision;
      const config: MatchConfig =
        m.protocolVersion === 2
          ? {
              ...common,
              identity: { ...identity, protocolVersion: 2 },
              timing: m.defaultTiming,
              resources: m.defaultResources,
              metering: m.defaultMetering,
            }
          : { ...common, identity: { ...identity, protocolVersion: 1 }, budgets: m.defaultBudgets };
      validateConfig(m, config, p.onHostEvent);
      return structuredClone(config);
    },
  };
}

function validatePolicies(
  timing: unknown,
  resources: unknown,
  metering: unknown,
  handler: unknown,
): void {
  if (!validateTimingPolicy(timing).ok) throw Error("invalid match timing");
  if (!validateResources(resources).ok || !validateMetering(metering, resources).ok)
    throw Error("invalid match resources or metering");
  if (
    (timing as { playerTotalMs: number | null }).playerTotalMs !== null &&
    typeof handler !== "function"
  )
    throw Error("player total time requires onHostEvent");
}
function validateConfig(manifest: AnyGameManifest, config: MatchConfig, handler: unknown): void {
  if (
    !config.matchId ||
    !Array.isArray(config.seats) ||
    !manifest.seatCounts.includes(config.seats.length) ||
    new Set(config.seats).size !== config.seats.length ||
    config.seats.some((s) => typeof s !== "string" || !/^seat:(0|[1-9][0-9]*)$/.test(s))
  )
    throw Error("invalid match seats");
  if (!validateSchema(manifest.rulesSchema, config.rules).ok) throw Error("invalid match rules");
  if (manifest.protocolVersion === 2) {
    if (
      Object.keys(config).some(
        (key) =>
          ![
            "identity",
            "matchId",
            "gameId",
            "seats",
            "rules",
            "timing",
            "resources",
            "metering",
          ].includes(key),
      )
    )
      throw Error("invalid match config fields");
    validatePolicies(config.timing, config.resources, config.metering, handler);
    return;
  }
  if (
    !config.budgets ||
    config.timing !== undefined ||
    config.resources !== undefined ||
    config.metering !== undefined ||
    Object.keys(manifest.defaultBudgets).some(
      (k) => typeof config.budgets?.[k as keyof typeof config.budgets] !== "number",
    ) ||
    Object.values(config.budgets).some((n) => !Number.isFinite(n) || n < 0)
  )
    throw Error("invalid match budgets");
}

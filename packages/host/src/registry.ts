import { isDeepStrictEqual } from "node:util";
import type { MatchConfig, SeatId } from "@benchboss/core";
import {
  type GameManifest,
  type GameRevision,
  RUNTIME_VERSION,
  validateSchema,
} from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";

export interface GameInfo extends GameManifest {
  manifest: GameManifest;
  id: string;
  seats: number;
  budgets: MatchConfig["budgets"];
  rules: Record<string, unknown>;
  phases: Record<string, string[]>;
}

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
    if (
      !p.manifest ||
      p.manifest.id !== p.id ||
      p.manifest.protocolVersion !== 1 ||
      !p.manifest.revision
    )
      throw new Error("invalid game manifest");
    const m = p.manifest;
    if (
      [m.id, m.revision, m.title, m.description, m.rulesSource].some(
        (v) => typeof v !== "string" || !v.trim(),
      ) ||
      !Array.isArray(m.roundStructure) ||
      !Array.isArray(m.winConditions) ||
      !Array.isArray(m.safeDefaults) ||
      m.disclosure !== "full-after-terminal" ||
      !m.defaultRules ||
      !m.defaultBudgets ||
      !validateSchema(m.rulesSchema, m.defaultRules).ok
    )
      throw new Error("invalid game manifest");
    if (
      !Array.isArray(m.seatCounts) ||
      m.seatCounts.length === 0 ||
      m.seatCounts.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      new Set(m.seatCounts).size !== m.seatCounts.length ||
      !m.seatCounts.includes(m.defaultSeats) ||
      m.defaultSeats !== p.defaultSeats ||
      !isDeepStrictEqual(m.defaultBudgets, p.defaultBudgets) ||
      !isDeepStrictEqual(m.defaultRules, p.defaultRules ?? {}) ||
      Object.values(m.defaultBudgets).some((n) => !Number.isFinite(n) || n < 0)
    )
      throw new Error("inconsistent game defaults");
    const key = `${p.id}@${p.manifest.revision}`;
    if (revisions.has(key)) throw new Error(`duplicate game id: ${key}`);
    revisions.set(key, p);
    if (p.manifest.revision !== options.legacyRevisions?.[p.id]) byId.set(p.id, p);
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by id
  const require = (id: string, revision?: string): GamePlugin<any> => {
    const p = revision === undefined ? byId.get(id) : revisions.get(`${id}@${revision}`);
    if (!p) throw new Error(`unknown game: ${id}`);
    return p;
  };
  return {
    has: (id) => byId.has(id),
    get: require,
    resolve: (config) => {
      const identity = config.identity;
      if (
        identity &&
        (identity.protocolVersion !== 1 ||
          identity.runtimeVersion !== RUNTIME_VERSION ||
          identity.gameId !== config.gameId)
      )
        throw new Error("unsupported match identity");
      const revision = identity?.revision ?? options.legacyRevisions?.[config.gameId];
      if (!revision) throw new Error(`legacy revision not registered: ${config.gameId}`);
      const plugin = require(config.gameId, revision);
      validateConfig(plugin.manifest, config);
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
          budgets: p.defaultBudgets,
          rules: p.defaultRules ?? {},
          phases: p.phaseToTools,
        }),
      ),
    buildConfig: (matchId, gameId, seats) => {
      const p = require(gameId);
      const config = {
        identity: {
          protocolVersion: 1,
          runtimeVersion: RUNTIME_VERSION,
          gameId,
          revision: p.manifest.revision,
        } satisfies GameRevision,
        matchId,
        gameId,
        seats,
        rules: p.defaultRules ?? {},
        budgets: p.defaultBudgets,
      };
      validateConfig(p.manifest, config);
      return structuredClone(config);
    },
  };
}

function validateConfig(manifest: GameManifest, config: MatchConfig): void {
  if (
    !config.matchId ||
    !manifest.seatCounts.includes(config.seats.length) ||
    new Set(config.seats).size !== config.seats.length ||
    config.seats.some((s) => typeof s !== "string" || !/^seat:(0|[1-9][0-9]*)$/.test(s))
  )
    throw new Error("invalid match seats");
  if (!validateSchema(manifest.rulesSchema, config.rules).ok)
    throw new Error("invalid match rules");
  if (
    Object.keys(manifest.defaultBudgets).some(
      (k) => typeof config.budgets[k as keyof typeof config.budgets] !== "number",
    )
  )
    throw new Error("invalid match budgets");
  if (Object.values(config.budgets).some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("invalid match budgets");
}

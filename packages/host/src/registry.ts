import { isDeepStrictEqual } from "node:util";
import { type MatchConfig, type SeatId, validateMatchConfig } from "@benchboss/core";
import {
  type GameManifest,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  validateMetering,
  validateResources,
  validateSchema,
  validateTimingPolicy,
} from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";

export type GameInfo = GameManifest & {
  manifest: GameManifest;
  id: string;
  seats: number;
  rules: Record<string, unknown>;
  phases: Record<string, string[]>;
};
export interface GameRegistry {
  has(id: string): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: registry holds heterogeneous game plugins
  get(id: string): GamePlugin<any>;
  resolve(config: MatchConfig): GamePlugin<unknown>;
  seatsFor(id: string): number;
  buildConfig(matchId: string, gameId: string, seats: SeatId[]): MatchConfig;
  list(): GameInfo[];
}

export function createRegistry(
  // biome-ignore lint/suspicious/noExplicitAny: registry holds heterogeneous game plugins
  plugins: GamePlugin<any>[],
): GameRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by id
  const byId = new Map<string, GamePlugin<any>>();
  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    if (!manifest || manifest.id !== plugin.id || manifest.protocolVersion !== PROTOCOL_VERSION)
      throw Error("invalid game manifest");
    if (
      [
        manifest.id,
        manifest.revision,
        manifest.title,
        manifest.description,
        manifest.rulesSource,
      ].some((value) => typeof value !== "string" || !value.trim()) ||
      !Array.isArray(manifest.roundStructure) ||
      !Array.isArray(manifest.winConditions) ||
      !Array.isArray(manifest.safeDefaults) ||
      manifest.disclosure !== "full-after-terminal" ||
      !manifest.defaultRules ||
      !validateSchema(manifest.rulesSchema, manifest.defaultRules).ok
    )
      throw Error("invalid game manifest");
    if (
      !Array.isArray(manifest.seatCounts) ||
      manifest.seatCounts.length === 0 ||
      manifest.seatCounts.some((count) => !Number.isSafeInteger(count) || count < 1) ||
      new Set(manifest.seatCounts).size !== manifest.seatCounts.length ||
      !manifest.seatCounts.includes(manifest.defaultSeats) ||
      manifest.defaultSeats !== plugin.defaultSeats ||
      !isDeepStrictEqual(manifest.defaultRules, plugin.defaultRules ?? {})
    )
      throw Error("inconsistent game defaults");
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
    if (Object.keys(manifest).some((key) => !allowed.has(key)))
      throw Error("invalid game manifest fields");
    validatePolicies(
      manifest.defaultTiming,
      manifest.defaultResources,
      manifest.defaultMetering,
      plugin.onHostEvent,
    );
    if (byId.has(plugin.id)) throw Error(`duplicate game id: ${plugin.id}`);
    byId.set(plugin.id, plugin);
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins keyed by id
  const require = (id: string): GamePlugin<any> => {
    const plugin = byId.get(id);
    if (!plugin) throw Error(`unknown game: ${id}`);
    return plugin;
  };
  return {
    has: (id) => byId.has(id),
    get: require,
    resolve: (config) => {
      const validation = validateMatchConfig(config);
      if (!validation.ok) throw Error(validation.reason);
      const plugin = require(config.gameId);
      validateConfig(plugin.manifest, config, plugin.onHostEvent);
      return plugin;
    },
    seatsFor: (id) => require(id).defaultSeats,
    list: () =>
      [...byId.values()].map((plugin) =>
        structuredClone({
          manifest: plugin.manifest,
          ...plugin.manifest,
          id: plugin.id,
          seats: plugin.defaultSeats,
          rules: plugin.manifest.defaultRules,
          phases: plugin.phaseToTools,
        }),
      ),
    buildConfig: (matchId, gameId, seats) => {
      const plugin = require(gameId);
      const manifest = plugin.manifest;
      const config: MatchConfig = {
        matchId,
        gameId,
        seats,
        rules: manifest.defaultRules,
        identity: {
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          gameId,
          revision: manifest.revision,
        },
        timing: manifest.defaultTiming,
        resources: manifest.defaultResources,
        metering: manifest.defaultMetering,
      };
      validateConfig(manifest, config, plugin.onHostEvent);
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
function validateConfig(manifest: GameManifest, config: MatchConfig, handler: unknown): void {
  const validation = validateMatchConfig(config, {
    gameId: manifest.id,
    manifest,
    hasHostEventHandler: typeof handler === "function",
  });
  if (!validation.ok) throw Error(validation.reason);
}

import type { MatchConfig, SeatId } from "@benchboss/core";
import type { GameManifest } from "@benchboss/protocol";

export function gameConfig(
  manifest: GameManifest,
  matchId: string,
  seats: SeatId[],
  rules = manifest.defaultRules,
): MatchConfig {
  return {
    identity: {
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
      gameId: manifest.id,
      revision: manifest.revision,
    },
    matchId,
    gameId: manifest.id,
    seats: [...seats],
    rules: structuredClone(rules),
    timing: structuredClone(manifest.defaultTiming),
    resources: structuredClone(manifest.defaultResources),
    metering: structuredClone(manifest.defaultMetering),
  };
}

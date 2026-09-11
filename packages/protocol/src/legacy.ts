import type { GameManifestBase } from "./index";

export const LEGACY_PROTOCOL_VERSION = 1 as const;
export const LEGACY_RUNTIME_VERSION = "0.1.0";

export interface LegacyBudgetConfig {
  wallClockMsPerDecision: number;
  toolCallsPerTurn: number;
  intelOrScoutPoints: number;
  simRolloutsPerTurn: number;
  invalidRetries: number;
}

export interface LegacyGameManifest extends GameManifestBase {
  protocolVersion: 1;
  defaultBudgets: LegacyBudgetConfig;
}

export interface LegacyGameRevision {
  protocolVersion: 1;
  runtimeVersion: string;
  gameId: string;
  revision: string;
}

export interface LegacyServerCapabilities {
  protocolVersion: 1;
}

export type LegacyNextEnvelope =
  | { kind: "turn"; matchId: string; seat: string; observation: unknown; deadline: number }
  | { kind: "match_over"; matchId: string; result: Record<string, number> }
  | { kind: "match_aborted"; matchId: string; reason: string }
  | { kind: "idle" };

export interface LegacySubmitEnvelope {
  ok: boolean;
  reason: string;
  observation?: unknown;
  result?: Record<string, unknown>;
}

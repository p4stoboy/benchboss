import type { ActionOffer, GameManifestBase } from "./index";

export const PROTOCOL_VERSION = 1 as const;
export const RUNTIME_VERSION = "0.1.0";

export interface TimingPolicy {
  playerTotalMs: number | null;
  decisionLimitMs: number | null;
  phaseLimits: Record<string, { durationMs: number; close: "ready_or_deadline" | "deadline" }>;
  clockVisibility: "private" | "public";
}

export interface ResourceAllowance {
  /** Nonnegative safe-integer units; zero is exhausted. */
  amount: number;
  reset: "match" | "phase" | "decision";
  visibility: "private" | "public";
}
export type ResourceAllowances = Record<string, ResourceAllowance>;
export type ResourceBalances = Record<string, number>;

export interface MeteringReference {
  resource: string;
  /** Nonnegative safe-integer resource units. */
  cost: number;
}
export interface MeteringPolicy {
  action?: MeteringReference;
  invalidAction?: MeteringReference;
}

export type Participation =
  | { status: "acting" | "waiting" }
  | { status: "finished"; reason: string };

export interface ClockSnapshot {
  sampledAt: number;
  remainingMs: number | null;
  running: boolean;
  deadline: number | null;
  phaseId: string;
  phaseDeadline: number | null;
}

export interface HostEvent {
  kind:
    | "decision_expired"
    | "player_time_exhausted"
    | "phase_expired"
    | "invalid_retries_exhausted";
  seats: string[];
  phaseId: string;
  at: number;
}

export interface ResultCause {
  kind: string;
  detail?: string;
  seats?: string[];
}

export interface GameManifest extends GameManifestBase {
  protocolVersion: 1;
  defaultTiming: TimingPolicy;
  defaultResources: ResourceAllowances;
  defaultMetering: MeteringPolicy;
}

export interface GameRevision {
  protocolVersion: 1;
  runtimeVersion: typeof RUNTIME_VERSION;
  gameId: string;
  revision: string;
}

export interface Observation {
  protocolVersion: 1;
  matchId: string;
  phase: string;
  phaseId: string;
  seat: string;
  publicState: Record<string, unknown>;
  privateState: Record<string, unknown>;
  legalTools: string[];
  decisionId: string;
  actionOffers: ActionOffer[];
  resources: ResourceBalances;
  participation: Participation;
  clock: ClockSnapshot;
}

export type NextEnvelope =
  | {
      protocolVersion: 1;
      kind: "turn" | "waiting";
      matchId: string;
      seat: string;
      observation: Observation;
      deadline: number | null;
    }
  | { protocolVersion: 1; kind: "seat_finished"; matchId: string; seat: string; reason: string }
  | { protocolVersion: 1; kind: "match_over"; matchId: string; result: Record<string, number> }
  | { protocolVersion: 1; kind: "match_aborted"; matchId: string; reason: string }
  | { protocolVersion: 1; kind: "idle" };

export interface SubmitEnvelope {
  protocolVersion: 1;
  ok: boolean;
  reason: string;
  observation?: Observation;
  result?: Record<string, unknown>;
}

export const CAPABILITY_FEATURES = [
  "timing.player_total",
  "timing.decision_limit",
  "timing.phase_deadline",
  "lifecycle.participation",
  "resources.named",
] as const;
export type CapabilityFeature = (typeof CAPABILITY_FEATURES)[number];

export interface ServerCapabilities {
  protocolVersion: 1;
  supportedProtocolVersions: 1[];
  features: CapabilityFeature[];
}
export const SERVER_CAPABILITIES: ServerCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  supportedProtocolVersions: [1],
  features: [...CAPABILITY_FEATURES],
};

// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { ActionId, MatchId, Phase, SeatId } from "@benchboss/core";

export type Alignment = "loyal" | "mole";
export type Role = "loyal" | "mole" | "handler" | "deepcover" | "analyst";
export type SpyPhase =
  | "briefing"
  | "intel"
  | "comms"
  | "proposal"
  | "vote"
  | "operation"
  | "debrief"
  | "assassinate";

export interface RoleDeal {
  roleBySeat: Record<SeatId, Role>;
  alignmentBySeat: Record<SeatId, Alignment>;
  moleSeats: SeatId[];
  /** For each seat: the mole seats visible to that seat. Moles see all moles (incl. self); Loyals see []; Handler sees moles minus Deep Cover. */
  knownMolesBySeat: Record<SeatId, SeatId[]>;
  /** Seat of the Handler (a Loyal who knows the Moles minus Deep Cover), or null for plain M2 matches. */
  handlerSeat: SeatId | null;
  /** Seat of the Deep Cover (a Mole invisible to the Handler), or null for plain M2 matches. */
  deepCoverSeat: SeatId | null;
}

export interface Proposal {
  proposalId: string;
  leader: SeatId;
  team: SeatId[];
  opIndex: number;
}

export interface MissionAction {
  seat: SeatId;
  sabotage: boolean;
}

export interface SpeechActRecord {
  actId: ActionId;
  seat: SeatId;
  seq: number;
  act: string;
  subject: SeatId | null;
  target: SeatId | null;
  roleClaim: Role | null;
  allegiance: Alignment | null;
  confidence: number | null;
  evidenceRef: string | null;
}

export interface IntelResult {
  actId: ActionId;
  seat: SeatId;
  tool: string;
  round: number;
  payload: Record<string, unknown>;
}

export interface OpResult {
  opIndex: number;
  team: SeatId[];
  sabotageCount: number;
  failed: boolean;
  // Hidden: who sabotaged, and which of them spent a protect_source on it.
  // Read only by intel.trace_operation; never by observe/score/isTerminal.
  saboteurs: SeatId[];
  untraceable: SeatId[];
}

export interface SpyState {
  matchId: MatchId;
  seats: SeatId[];
  deal: RoleDeal;
  phase: SpyPhase;
  round: number;
  opIndex: number;
  leaderIdx: number;
  rejectStreak: number;
  successes: number;
  fails: number;
  proposal: Proposal | null;
  votes: Record<SeatId, "approve" | "reject">;
  missionActions: MissionAction[];
  opResults: OpResult[];
  log: SpeechActRecord[];
  intelResults: Record<SeatId, IntelResult[]>;
  commsCountThisRound: Record<SeatId, number>;
  phaseEnded: Record<SeatId, boolean>;
  winner: Alignment | null;
  winReason: string;
  nextActSeq: number;
  assassinGuess: SeatId | null;
  misinfoFlags: Record<SeatId, boolean>;
  protectedSources: SeatId[];
}

// Phase label widening so SpyState.phase satisfies the Core Phase type.
export type SpyPhaseLabel = SpyPhase & Phase;

// PARTIAL observation envelope (sensing addendum): observe() returns only
// { matchId, phase, seat, publicState, privateState }. Public spy fields live in
// publicState; this-seat-only hidden fields in privateState. The server injects
// legalTools + budgets when it completes this into the full §4 ObservationEnvelope.
export interface SpyPublicState {
  seats: SeatId[];
  round: number;
  opIndex: number;
  leader: SeatId;
  teamSize: number;
  successes: number;
  fails: number;
  rejectStreak: number;
  proposal: { team: SeatId[]; proposalId: string } | null;
  opResults: Array<{
    opIndex: number;
    sabotageCount: number;
    failed: boolean;
    team: SeatId[];
  }>;
  log: SpeechActRecord[];
}

export interface SpyPrivateState {
  ownRole: Role;
  knownMoles: SeatId[];
  ownIntel: IntelResult[];
}

export interface SpyObservation {
  matchId: MatchId;
  phase: SpyPhase;
  seat: SeatId;
  publicState: SpyPublicState;
  privateState: SpyPrivateState;
}

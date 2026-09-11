// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
export { makeSpyGame, SPY_GAME_ID, PHASE_TOOLS } from "./game";
export { spySenseResolvers } from "./sensing";
export { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "./phases";
export { dealRoles, SPY_ROLE_TABLE } from "./roles";
export { teamSize, failThreshold, MISSION_TEAM_SIZES, MISSION_FAIL_THRESHOLDS } from "./missions";
export { evaluateWin } from "./win";
export {
  scanAlignment,
  auditStatement,
  traceOperation,
  SCAN_RELIABILITY,
  AUDIT_RELIABILITY,
  TRACE_RELIABILITY,
} from "./intel";
export { plantMisinfo, counterIntel, protectSource, COUNTERINTEL_MISS } from "./deception";
export * from "./schemas";
export type { SpyAction } from "./schemas";
export type {
  Alignment,
  Role,
  SpyPhase,
  RoleDeal,
  Proposal,
  MissionAction,
  SpeechActRecord,
  IntelResult,
  OpResult,
  SpyState,
  SpyObservation,
} from "./types";
export { plugin } from "./plugin";

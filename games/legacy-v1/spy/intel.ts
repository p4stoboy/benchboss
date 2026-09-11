// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { ActionId, Rng, SeatId } from "@benchboss/core";
import type { Alignment, SpeechActRecord, SpyState } from "./types";

// Every reader is a noisy oracle over hidden state. Reliability is the
// probability the oracle reports the truth; the complement flips it.
export const SCAN_RELIABILITY = 0.75;
export const AUDIT_RELIABILITY = 0.75;
export const TRACE_RELIABILITY = 0.75;

export interface ScanResult {
  target: SeatId;
  signal: Alignment;
}

export interface AuditResult {
  actId: ActionId;
  act: string | null;
  truthful: boolean | null;
}

export interface TraceResult {
  opIndex: number;
  suspects: SeatId[];
}

function flip(a: Alignment): Alignment {
  return a === "loyal" ? "mole" : "loyal";
}

// A misinfo flag on the target forces one "loyal" reading and is consumed by it.
export function scanAlignment(
  state: SpyState,
  target: SeatId,
  rng: Rng,
): { result: ScanResult; nextState: SpyState } {
  if (state.misinfoFlags[target]) {
    const { [target]: _spent, ...misinfoFlags } = state.misinfoFlags;
    return { result: { target, signal: "loyal" }, nextState: { ...state, misinfoFlags } };
  }
  const truth = state.deal.alignmentBySeat[target];
  if (truth === undefined) return { result: { target, signal: "loyal" }, nextState: state };
  const signal = rng.nextFloat() < SCAN_RELIABILITY ? truth : flip(truth);
  return { result: { target, signal }, nextState: state };
}

// Ground truth of a speech act's claim, or null when the act makes no
// checkable claim about hidden state.
function claimTruth(state: SpyState, act: SpeechActRecord): boolean | null {
  const alignmentOf = (s: SeatId | null) =>
    s === null ? undefined : state.deal.alignmentBySeat[s];
  switch (act.act) {
    case "claim_alignment":
    case "report_intel": {
      const truth = alignmentOf(act.subject);
      if (truth === undefined || act.allegiance === null) return null;
      return truth === act.allegiance;
    }
    case "claim_role": {
      const subject = act.subject ?? act.seat;
      const truth = state.deal.roleBySeat[subject];
      if (truth === undefined || act.roleClaim === null) return null;
      return truth === act.roleClaim;
    }
    case "accuse":
      return alignmentOf(act.target) === undefined ? null : alignmentOf(act.target) === "mole";
    case "vouch":
      return alignmentOf(act.target) === undefined ? null : alignmentOf(act.target) === "loyal";
    default:
      return null;
  }
}

// Polygraph: the truth of the cited claim, wrong with probability 1 - AUDIT_RELIABILITY.
export function auditStatement(state: SpyState, actId: ActionId, rng: Rng): AuditResult {
  const cited = state.log.find((e) => e.actId === actId);
  if (cited === undefined) return { actId, act: null, truthful: null };
  const truth = claimTruth(state, cited);
  if (truth === null) return { actId, act: cited.act, truthful: null };
  const truthful = rng.nextFloat() < AUDIT_RELIABILITY ? truth : !truth;
  return { actId, act: cited.act, truthful };
}

// Forensics on a failed op: one suspect per sabotage, each a real (traceable)
// saboteur with probability TRACE_RELIABILITY, else an innocent teammate.
// Suspects are always on the team; a pool that runs dry falls back to the other.
export function traceOperation(state: SpyState, opIndex: number, rng: Rng): TraceResult {
  const op = state.opResults.find((o) => o.opIndex === opIndex);
  if (op === undefined || !op.failed || op.sabotageCount === 0) return { opIndex, suspects: [] };
  const traceable = op.team.filter((s) => op.saboteurs.includes(s) && !op.untraceable.includes(s));
  const innocents = op.team.filter((s) => !op.saboteurs.includes(s));
  const suspects: SeatId[] = [];
  for (let slot = 0; slot < op.sabotageCount; slot++) {
    const wantTruth = rng.nextFloat() < TRACE_RELIABILITY;
    const preferred = wantTruth ? traceable : innocents;
    const fallback = wantTruth ? innocents : traceable;
    const pool = preferred.length > 0 ? preferred : fallback;
    if (pool.length === 0) break;
    const pick = rng.pick(pool);
    suspects.push(pick);
    for (const arr of [traceable, innocents]) {
      const i = arr.indexOf(pick);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  return { opIndex, suspects: suspects.sort() };
}

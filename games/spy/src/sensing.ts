import type { SeatId } from "@benchboss/core";
import type { SenseResolver } from "@benchboss/referee";
import { counterIntel, plantMisinfo, protectSource } from "./deception";
import { auditStatement, scanAlignment, traceOperation } from "./intel";
import type { IntelResult, SpyState } from "./types";

// The referee spends the named resource at the callTool boundary and forks the rng per
// call; resolvers never touch resources and never advance the phase. Results go
// to the caller's private intelResults only.

const RESOURCE = "research";
const MOLE_ONLY = { error: "mole_only" } as const;

function isMole(state: SpyState, seat: SeatId): boolean {
  return state.deal.alignmentBySeat[seat] === "mole";
}

function append(
  state: SpyState,
  seat: SeatId,
  tool: string,
  payload: Record<string, unknown>,
): SpyState {
  const existing = state.intelResults[seat] ?? [];
  const rec: IntelResult = {
    actId: `intel:${tool}:${seat}:${existing.length}`,
    seat,
    tool,
    round: state.round,
    payload,
  };
  return { ...state, intelResults: { ...state.intelResults, [seat]: [...existing, rec] } };
}

export function spySenseResolvers(_seed: string): SenseResolver<SpyState>[] {
  return [
    {
      tool: "intel.scan_alignment",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { target } = input as { target: SeatId };
        const { result, nextState } = scanAlignment(state, target, rng);
        return {
          result: { ...result },
          nextState: append(nextState, seat, "intel.scan_alignment", { ...result }),
        };
      },
    },
    {
      tool: "intel.audit_statement",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { actId } = input as { actId: string };
        const result = auditStatement(state, actId, rng);
        return {
          result: { ...result },
          nextState: append(state, seat, "intel.audit_statement", { ...result }),
        };
      },
    },
    {
      tool: "intel.trace_operation",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { opIndex } = input as { opIndex: number };
        const result = traceOperation(state, opIndex, rng);
        return {
          result: { ...result },
          nextState: append(state, seat, "intel.trace_operation", { ...result }),
        };
      },
    },
    {
      tool: "intel.plant_misinfo",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat, input) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        const { target } = input as { target: SeatId };
        return { result: { planted: true, target }, nextState: plantMisinfo(state, target) };
      },
    },
    {
      tool: "intel.counterintel",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat, _input, rng) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        const result = counterIntel(state, seat, rng);
        return {
          result: { ...result },
          nextState: append(state, seat, "intel.counterintel", { ...result }),
        };
      },
    },
    {
      tool: "intel.protect_source",
      resource: RESOURCE,
      cost: () => 1,
      resolve(state, seat) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        return { result: { protected: true }, nextState: protectSource(state, seat) };
      },
    },
  ];
}

import type { SeatId } from "@benchboss/core";
import type { LegacySenseResolver as SenseResolver } from "@benchboss/referee";
import { counterIntel, plantMisinfo, protectSource } from "./deception";
import { auditStatement, scanAlignment, traceOperation } from "./intel";
import type { IntelResult, SpyState } from "./types";

// The referee spends budgetKey at the callTool boundary and forks the rng per
// call; resolvers never touch budgets and never advance the phase. Results go
// to the caller's private intelResults only.

const BUDGET = "intelOrScoutPoints" as const;
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
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { target } = input as { target: SeatId };
        const { result, nextState } = scanAlignment(state, target, rng);
        return {
          result: { ...result },
          nextState: append(nextState, seat, this.tool, { ...result }),
        };
      },
    },
    {
      tool: "intel.audit_statement",
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { actId } = input as { actId: string };
        const result = auditStatement(state, actId, rng);
        return { result: { ...result }, nextState: append(state, seat, this.tool, { ...result }) };
      },
    },
    {
      tool: "intel.trace_operation",
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat, input, rng) {
        const { opIndex } = input as { opIndex: number };
        const result = traceOperation(state, opIndex, rng);
        return { result: { ...result }, nextState: append(state, seat, this.tool, { ...result }) };
      },
    },
    {
      tool: "intel.plant_misinfo",
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat, input) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        const { target } = input as { target: SeatId };
        return { result: { planted: true, target }, nextState: plantMisinfo(state, target) };
      },
    },
    {
      tool: "intel.counterintel",
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat, _input, rng) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        const result = counterIntel(state, seat, rng);
        return { result: { ...result }, nextState: append(state, seat, this.tool, { ...result }) };
      },
    },
    {
      tool: "intel.protect_source",
      budgetKey: BUDGET,
      cost: () => 1,
      resolve(state, seat) {
        if (!isMole(state, seat)) return { result: MOLE_ONLY, nextState: state };
        return { result: { protected: true }, nextState: protectSource(state, seat) };
      },
    },
  ];
}

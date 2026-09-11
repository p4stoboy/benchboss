import type { Rng, SeatId } from "@benchboss/core";

export interface SenseResult {
  result: Record<string, unknown>;
}

// A sensing tool: read-or-private-write, metered against a per-seat sensing
// budget, resolved at the server boundary, NEVER advances the phase.
export interface SenseResolver<State> {
  tool: string; // MCP tool name, e.g. "match.scout_opponent"
  budgetKey: "intelOrScoutPoints" | "simRolloutsPerTurn";
  cost(input: unknown): number; // points to spend this call (scout => 1; sim => clamped n)
  resolve(
    state: State,
    seat: SeatId,
    input: unknown,
    rng: Rng,
  ): { result: Record<string, unknown>; nextState: State }; // nextState === state when read-only
}

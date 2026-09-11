// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { SeatId } from "@benchboss/core";
import { PHASE_TOOLS } from "./game";
import { teamSize } from "./missions";
import type { SpyState } from "./types";

export const SPY_PHASE_TOOLS: Record<string, string[]> = PHASE_TOOLS;

export function currentPhase(state: SpyState): string {
  return state.phase;
}

export function isReady(state: SpyState): boolean {
  switch (state.phase) {
    case "briefing":
    case "intel":
    case "comms":
    case "debrief":
      return state.seats.every((s) => state.phaseEnded[s]);
    case "proposal":
      return state.proposal !== null;
    case "vote":
      return state.seats.every((s) => state.votes[s] !== undefined);
    case "operation": {
      if (!state.proposal) return false;
      const { team } = state.proposal;
      return team.every((s) => state.missionActions.some((m) => m.seat === s));
    }
    case "assassinate":
      return state.assassinGuess !== null;
    default:
      return false;
  }
}

export function spySafeDefault(state: SpyState, _seat: SeatId): unknown {
  switch (state.phase) {
    case "proposal": {
      const size = teamSize(state.seats.length, state.opIndex);
      const leaderIdx = state.leaderIdx;
      const leader = state.seats[leaderIdx];
      if (leader === undefined) {
        throw new Error(`invalid leaderIdx ${leaderIdx}`);
      }
      const team = [leader, ...state.seats.filter((s) => s !== leader)].slice(0, size);
      return { team };
    }
    case "vote":
      return { vote: "reject" };
    case "operation":
      return { sabotage: false };
    case "assassinate": {
      // Timed-out assassin makes a guaranteed-wrong guess → Loyal win.
      // Inaction is penalized; this also keeps the safe default schema-valid so the phase always resolves.
      const nonHandler = state.seats.find((s) => s !== state.deal.handlerSeat);
      if (nonHandler === undefined) {
        // Degenerate: all 5 seats are the handler — cannot happen in a valid deal.
        const fallback = state.seats[0];
        if (fallback === undefined) throw new Error("assassinate safe default: no seats in state");
        return { target: fallback };
      }
      return { target: nonHandler };
    }
    default:
      return {};
  }
}

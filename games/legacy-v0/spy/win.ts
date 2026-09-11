import type { Alignment, SpyState } from "./types";

export function evaluateWin(state: SpyState): {
  over: boolean;
  winner: Alignment | null;
  reason: string;
} {
  const hasHandler = state.deal.handlerSeat !== null;
  if (state.successes >= 3) {
    if (hasHandler && state.assassinGuess === null && state.phase !== "assassinate") {
      return { over: false, winner: null, reason: "" }; // enter assassinate
    }
    if (hasHandler && state.assassinGuess !== null) {
      if (state.assassinGuess === state.deal.handlerSeat) {
        return { over: true, winner: "mole", reason: "assassin" };
      }
      return { over: true, winner: "loyal", reason: "three-successful-ops" };
    }
    if (!hasHandler) return { over: true, winner: "loyal", reason: "three-successful-ops" };
  }
  if (state.fails >= 3) return { over: true, winner: "mole", reason: "three-failed-ops" };
  if (state.rejectStreak >= 5) return { over: true, winner: "mole", reason: "hammer" };
  return { over: false, winner: null, reason: "" };
}

import type { Rng, SeatId } from "@benchboss/core";
import type { SpyState } from "./types";

// Probability counterintel drops one genuine scanner from its answer.
export const COUNTERINTEL_MISS = 0.25;

// plant_misinfo: the next scan of `target` reads "loyal" whatever the truth.
// One shot; consumed by that scan.
export function plantMisinfo(state: SpyState, target: SeatId): SpyState {
  return { ...state, misinfoFlags: { ...state.misinfoFlags, [target]: true } };
}

// counterintel: who has scanned `seat` this match, minus one at random with
// probability COUNTERINTEL_MISS. Never names a seat that did not scan.
export function counterIntel(state: SpyState, seat: SeatId, rng: Rng): { scannedBy: SeatId[] } {
  const scanners = state.seats.filter((s) =>
    (state.intelResults[s] ?? []).some(
      (r) =>
        r.tool === "intel.scan_alignment" && (r.payload as { target?: SeatId }).target === seat,
    ),
  );
  if (scanners.length > 0 && rng.nextFloat() < COUNTERINTEL_MISS) {
    const dropped = rng.pick(scanners);
    return { scannedBy: scanners.filter((s) => s !== dropped) };
  }
  return { scannedBy: scanners };
}

// protect_source: the seat's next sabotage is untraceable. Idempotent; the
// protection is consumed by the sabotage (see game.step operation branch).
export function protectSource(state: SpyState, seat: SeatId): SpyState {
  if (state.protectedSources.includes(seat)) return state;
  return { ...state, protectedSources: [...state.protectedSources, seat] };
}

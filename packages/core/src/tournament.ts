import { mkSeatId } from "./types";
import type { BudgetConfig, MatchConfig, SeatId } from "./types";

export function scheduleTournament(
  budgets: BudgetConfig,
  args: {
    agents: string[];
    gameId: string;
    seedBatch: string[];
    rotateSeatsAndRoles: boolean;
  },
): MatchConfig[] {
  const { agents, gameId, seedBatch, rotateSeatsAndRoles } = args;
  const n = agents.length;
  const seats: SeatId[] = Array.from({ length: n }, (_, i) => mkSeatId(i));

  return seedBatch.map((seed, seedIndex) => {
    const shift = rotateSeatsAndRoles ? seedIndex % n : 0;
    const seatAssignment = Array.from({ length: n }, (_, seatIdx) => {
      // biome-ignore lint/style/noNonNullAssertion: modulo arithmetic guarantees index is in bounds
      return agents[(seatIdx + shift) % n]!;
    });
    return {
      matchId: `${gameId}:${seed}`,
      gameId,
      seats,
      rules: { seatAssignment, seedIndex, seed },
      budgets,
    };
  });
}

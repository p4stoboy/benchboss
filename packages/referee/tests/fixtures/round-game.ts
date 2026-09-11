// Frozen test-only simultaneous-round fixture; independent of the official catalog.
import type {
  GameModule,
  LegalActionSpec,
  MatchConfig,
  SeatId,
  SubmitResult,
} from "@benchboss/core";
import { toInputSchema } from "@benchboss/schemas";
import { z } from "zod";

export type Throw = "rock" | "paper" | "scissors";

export interface RpsState {
  matchId: string;
  phase: "throw" | "resolve" | "terminal";
  round: number;
  rounds: number;
  seats: SeatId[];
  committed: Record<SeatId, Throw | null>;
  revealed: Record<SeatId, Throw> | null;
  wins: Record<SeatId, number>;
  seed: string;
}

export interface RpsAction {
  throw: Throw;
}

export interface RpsObservation {
  matchId: string;
  phase: string;
  seat: string;
  publicState: {
    round: number;
    rounds: number;
    wins: Record<string, number>;
    committedSeats: string[];
  };
  privateState: { yourThrow: Throw | null };
  legalTools: string[];
}

export const rpsThrowSchema = z.object({ throw: z.enum(["rock", "paper", "scissors"]) }).strict();

export const RPS_PHASE_TOOLS: Record<string, string[]> = {
  throw: ["match.throw"],
  // "resolve" is a reserved phase for engine symmetry; rps-n advances throw -> terminal directly and never enters it.
  resolve: [],
  terminal: [],
};

const BEATS: Record<Throw, Throw> = {
  rock: "scissors",
  scissors: "paper",
  paper: "rock",
};

export function makeRpsN(): GameModule<RpsState, RpsAction, RpsObservation, number> {
  return {
    id: "rps-n",

    newMatch(config: MatchConfig, seed: string): RpsState {
      const rounds = typeof config.rules.rounds === "number" ? config.rules.rounds : 3;
      const committed = {} as Record<SeatId, Throw | null>;
      const wins = {} as Record<SeatId, number>;
      for (const seat of config.seats) {
        committed[seat] = null;
        wins[seat] = 0;
      }
      return {
        matchId: config.matchId,
        phase: "throw",
        round: 0,
        rounds,
        seats: [...config.seats],
        committed,
        revealed: null,
        wins,
        seed,
      };
    },

    observe(state: RpsState, seat: SeatId): RpsObservation {
      const committedSeats = state.seats.filter((s) => state.committed[s] !== null);
      return {
        matchId: state.matchId,
        phase: state.phase,
        seat,
        publicState: {
          round: state.round,
          rounds: state.rounds,
          wins: { ...state.wins },
          committedSeats: committedSeats.map(String),
        },
        privateState: { yourThrow: state.committed[seat] ?? null },
        legalTools: RPS_PHASE_TOOLS[state.phase] ?? [],
      };
    },

    legalActions(state: RpsState, seat: SeatId): LegalActionSpec[] {
      if (state.phase !== "throw") return [];
      if (state.committed[seat] !== null) return [];
      return [
        {
          tool: "match.throw",
          description: "Privately commit rock, paper or scissors for this round.",
          phase: "throw",
          jsonSchema: toInputSchema(rpsThrowSchema),
        },
      ];
    },

    submit(state: RpsState, seat: SeatId, action: RpsAction): SubmitResult<RpsState> {
      if (state.phase !== "throw") {
        return {
          accepted: false,
          reason: `cannot throw in phase ${state.phase}`,
          state,
        };
      }
      if (state.committed[seat] !== null) {
        return {
          accepted: false,
          reason: "seat already committed this round",
          state,
        };
      }
      const parsed = rpsThrowSchema.safeParse(action);
      if (!parsed.success) {
        return { accepted: false, reason: "invalid throw", state };
      }
      const committed = { ...state.committed, [seat]: action.throw };
      return {
        accepted: true,
        reason: "ok",
        committedActionId: `${state.matchId}:r${state.round}:${seat}`,
        state: { ...state, committed },
      };
    },

    step(state: RpsState): RpsState {
      if (state.phase !== "throw") return state;
      const allCommitted = state.seats.every((s) => state.committed[s] !== null);
      if (!allCommitted) return state;

      const revealed = {} as Record<SeatId, Throw>;
      for (const s of state.seats) revealed[s] = state.committed[s] as Throw;

      const wins = { ...state.wins };
      for (const a of state.seats) {
        for (const b of state.seats) {
          if (a === b) continue;
          const throwA = revealed[a];
          const throwB = revealed[b];
          if (throwA === undefined || throwB === undefined) continue;
          const beats = BEATS[throwA];
          const current = wins[a];
          if (beats === throwB && current !== undefined) wins[a] = current + 1;
        }
      }

      const nextRound = state.round + 1;
      const cleared = {} as Record<SeatId, Throw | null>;
      for (const s of state.seats) cleared[s] = null;

      return {
        ...state,
        round: nextRound,
        committed: cleared,
        revealed,
        wins,
        phase: nextRound >= state.rounds ? "terminal" : "throw",
      };
    },

    isTerminal(state: RpsState): boolean {
      return state.phase === "terminal";
    },

    score(state: RpsState): Record<SeatId, number> {
      return { ...state.wins };
    },
  };
}

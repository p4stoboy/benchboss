import type { GameRevision } from "@benchboss/protocol";
export type SeatId = string & { readonly __brand: "SeatId" };
export type MatchId = string;
export type ActionId = string;
export type Phase = string;

export const mkSeatId = (n: number): SeatId => `seat:${n}` as SeatId;

export interface MatchConfig {
  identity?: GameRevision;
  matchId: MatchId;
  gameId: string;
  seats: SeatId[];
  rules: Record<string, unknown>;
  budgets: BudgetConfig;
}

export interface BudgetConfig {
  wallClockMsPerDecision: number;
  toolCallsPerTurn: number;
  intelOrScoutPoints: number;
  simRolloutsPerTurn: number;
  invalidRetries: number;
}

export interface LegalActionSpec {
  description?: string;
  tool: string;
  phase: Phase;
  jsonSchema: Record<string, unknown>;
}

export interface SubmitResult<State> {
  accepted: boolean;
  reason: string;
  committedActionId?: ActionId;
  state: State;
}

export interface GameModule<State, Action, Observation, Score> {
  id: string;
  newMatch(config: MatchConfig, seed: string): State;
  observe(state: State, seat: SeatId): Observation;
  legalActions(state: State, seat: SeatId): LegalActionSpec[];
  submit(state: State, seat: SeatId, action: Action, tool?: string): SubmitResult<State>;
  step(state: State): State;
  isTerminal(state: State): boolean;
  score(state: State): Record<SeatId, Score>;
}

export interface Rng {
  readonly seed: string;
  nextU32(): number;
  nextFloat(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
  fork(label: string): Rng;
}

export interface LogEvent {
  seq: number;
  matchId: MatchId;
  phase: Phase;
  seat: SeatId | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface PhaseMachine<State> {
  current(state: State): Phase;
  toolsLegalIn(phase: Phase): string[];
  collect(state: State, seat: SeatId, tool: string, input: unknown): SubmitResult<State>;
  ready(state: State): boolean;
  resolve(state: State): State;
}

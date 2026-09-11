import type {
  CurrentGameRevision,
  LegacyBudgetConfig,
  LegacyGameRevision,
  MeteringPolicy,
  ResourceAllowances,
  TimingPolicy,
} from "@benchboss/protocol";
export type { LegacyBudgetConfig } from "@benchboss/protocol";
export type SeatId = string & { readonly __brand: "SeatId" };
export type MatchId = string;
export type ActionId = string;
export type Phase = string;

export const mkSeatId = (n: number): SeatId => `seat:${n}` as SeatId;

export interface MatchConfigBase {
  matchId: MatchId;
  gameId: string;
  seats: SeatId[];
  rules: Record<string, unknown>;
}

export interface CurrentMatchConfig extends MatchConfigBase {
  identity: CurrentGameRevision;
  timing: TimingPolicy;
  resources: ResourceAllowances;
  metering: MeteringPolicy;
  budgets?: never;
}

export interface LegacyMatchConfig extends MatchConfigBase {
  identity?: LegacyGameRevision;
  budgets: LegacyBudgetConfig;
  timing?: never;
  resources?: never;
  metering?: never;
}

export type MatchConfig = CurrentMatchConfig | LegacyMatchConfig;
/** Historical v1 compatibility only; current configurations use named resources. */
export type BudgetConfig = LegacyBudgetConfig;

export function isCurrentMatchConfig(config: MatchConfig): config is CurrentMatchConfig {
  return config.identity?.protocolVersion === 2;
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

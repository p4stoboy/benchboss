import type { GameModule, MatchConfig, SeatId } from "@benchboss/core";
import type {
  ActionInvocation,
  HostEvent,
  Participation,
  SpectatorView,
} from "@benchboss/protocol";
import * as legacy from "./legacy-match-server";
import type { AnySenseResolver } from "./sense-resolver";
import * as current from "./v2-match-server";

export type MatchSession<State> = legacy.MatchSession<State> | current.CurrentMatchSession<State>;
export type Command = legacy.Command | { kind: "advanceTime"; at: number };
export type StepOutput = legacy.StepOutput;
export interface MatchHandle<State> {
  get: () => MatchSession<State>;
  advance: (cmd: Command) => StepOutput;
}
export interface SessionOptions<State> {
  publicView?: (state: State) => SpectatorView;
  // biome-ignore lint/suspicious/noExplicitAny: game action, observation and score are opaque to the referee
  game: GameModule<State, any, any, any>;
  config: MatchConfig;
  seed: string;
  phaseToTools: Record<string, string[]>;
  currentPhase: (state: State) => string;
  isReady: (state: State) => boolean;
  safeDefault: (state: State, seat: SeatId) => unknown;
  defaultAction?: (state: State, seat: SeatId) => ActionInvocation;
  senseResolvers?: AnySenseResolver<State>[];
  terminalSummary?: (state: State) => Record<string, unknown>;
  resolveSummary?: (state: State, phase: string) => Record<string, unknown>;
  participation?: (state: State, seat: SeatId) => Participation;
  onHostEvent?: (state: State, event: HostEvent) => State;
}
export function newSession<State>(options: SessionOptions<State>): MatchSession<State> {
  if (options.config.identity?.protocolVersion === 2) return current.newCurrentSession(options);
  if (options.config.identity && options.config.identity.protocolVersion !== 1)
    throw Error("unsupported protocol version");
  if (options.config.timing !== undefined) throw Error("v2 configuration requires v2 identity");
  return legacy.newSession({ ...options, config: options.config });
}
export function step<State>(
  session: MatchSession<State>,
  command: Command,
): { session: MatchSession<State>; output: StepOutput } {
  if ("runtimeV2" in session) return current.stepCurrent(session, command);
  if (command.kind === "advanceTime")
    return { session, output: { ok: true, reason: "legacy time is host-owned" } };
  return legacy.step(session, command);
}
export const sessionState = <State>(session: MatchSession<State>): State => session.state;
export const sessionLog = <State>(session: MatchSession<State>) => session.log;
export const isTerminal = <State>(session: MatchSession<State>): boolean =>
  session.game.isTerminal(session.state);
export const decisionId = <State>(session: MatchSession<State>, seat: SeatId): string =>
  `${session.config.matchId}:${seat}:${session.decisionEpoch}:${session.seatDecisions[seat] ?? 0}`;
export const phaseId = <State>(session: MatchSession<State>): string =>
  `${session.config.matchId}:${session.decisionEpoch}`;
export function participation<State>(session: MatchSession<State>, seat: SeatId): Participation {
  if ("runtimeV2" in session) return current.currentParticipation(session, seat);
  if (isTerminal(session)) return { status: "finished", reason: "match_over" };
  return {
    status: session.game
      .legalActions(session.state, seat)
      .some((offer) => !session.senseResolvers.has(offer.tool))
      ? "acting"
      : "waiting",
  };
}
export const clockSnapshot = <State>(session: MatchSession<State>, seat: SeatId) =>
  "runtimeV2" in session ? current.currentClockSnapshot(session, seat) : null;
export const observe = <State>(session: MatchSession<State>, seat: SeatId): unknown =>
  "runtimeV2" in session ? current.observeCurrent(session, seat) : legacy.observe(session, seat);
export const publicView = <State>(session: MatchSession<State>): SpectatorView =>
  "runtimeV2" in session ? current.publicViewCurrent(session) : legacy.publicView(session);
export const publicFrames = <State>(session: MatchSession<State>) =>
  structuredClone([...session.frames]);

import {
  appendEvent,
  createPhaseMachine,
  createRng,
  initBudgetBook,
  remaining,
  resetTurnBudgets,
  safeDefaultTriggered,
  sha256Commit,
  spend,
} from "@benchboss/core";
import type {
  BudgetBook,
  BudgetConfig,
  GameModule,
  LogEvent,
  MatchConfig,
  PhaseMachine,
  Rng,
  SeatId,
} from "@benchboss/core";
import type { ActionInvocation, PublicFrame, SpectatorView } from "@benchboss/protocol";
import { validateSchema } from "@benchboss/protocol";
import { ObservationEnvelope } from "@benchboss/schemas";
import type { SenseResolver } from "./sense-resolver";

const BUDGET_KEYS: (keyof BudgetConfig)[] = [
  "wallClockMsPerDecision",
  "toolCallsPerTurn",
  "intelOrScoutPoints",
  "simRolloutsPerTurn",
  "invalidRetries",
];

export interface MatchSession<State> {
  projectPublic?: (state: State) => SpectatorView;
  frames: readonly PublicFrame[];
  decisionEpoch: number;
  seatDecisions: Readonly<Record<SeatId, number>>;
  // biome-ignore lint/suspicious/noExplicitAny: GameModule is covariant here; the session is Action/Observation/Score-agnostic
  game: GameModule<State, any, any, any>;
  config: MatchConfig;
  seed: string;
  state: State;
  senseSeq: number;
  terminalWritten: boolean;
  lastTurnPhase: Readonly<Record<SeatId, string>>;
  budgets: BudgetBook;
  log: readonly LogEvent[];
  matchRng: Rng;
  pm: PhaseMachine<State>;
  currentPhase: (s: State) => string;
  safeDefault: (s: State, seat: SeatId) => unknown;
  defaultAction?: (s: State, seat: SeatId) => ActionInvocation;
  senseResolvers: ReadonlyMap<string, SenseResolver<State>>;
  terminalSummary: (s: State) => Record<string, unknown>;
  resolveSummary: (s: State, resolvedPhase: string) => Record<string, unknown>;
}

export type Command =
  | { kind: "callTool"; seat: SeatId; tool: string; input: unknown }
  | { kind: "commitDefault"; seat: SeatId };

export interface StepOutput {
  ok: boolean;
  reason: string;
  observation?: unknown;
  result?: Record<string, unknown>;
}

export interface MatchHandle<State> {
  get: () => MatchSession<State>;
  advance: (cmd: Command) => StepOutput;
}

export function newSession<State>(opts: {
  publicView?: (state: State) => SpectatorView;
  // biome-ignore lint/suspicious/noExplicitAny: GameModule is covariant here; the session is Action/Observation/Score-agnostic
  game: GameModule<State, any, any, any>;
  config: MatchConfig;
  seed: string;
  phaseToTools: Record<string, string[]>;
  currentPhase: (s: State) => string;
  isReady: (s: State) => boolean;
  safeDefault: (s: State, seat: SeatId) => unknown;
  defaultAction?: (s: State, seat: SeatId) => ActionInvocation;
  senseResolvers?: SenseResolver<State>[];
  terminalSummary?: (s: State) => Record<string, unknown>;
  resolveSummary?: (s: State, resolvedPhase: string) => Record<string, unknown>;
}): MatchSession<State> {
  const log = appendEvent([], {
    matchId: opts.config.matchId,
    phase: "init",
    seat: null,
    kind: "rng.commit",
    payload: { hash: sha256Commit(opts.seed) },
  });
  const state = opts.game.newMatch(opts.config, opts.seed);
  return {
    projectPublic: opts.publicView,
    frames: opts.publicView
      ? [{ seq: log.length - 1, view: structuredClone(opts.publicView(state)) }]
      : [],
    decisionEpoch: 0,
    seatDecisions: {},
    game: opts.game,
    config: opts.config,
    seed: opts.seed,
    state,
    senseSeq: 0,
    terminalWritten: false,
    lastTurnPhase: {},
    budgets: initBudgetBook(opts.config.seats, opts.config.budgets),
    log,
    matchRng: createRng(opts.seed),
    pm: createPhaseMachine<State>(opts.game, opts.phaseToTools, opts.currentPhase, opts.isReady),
    currentPhase: opts.currentPhase,
    safeDefault: opts.safeDefault,
    defaultAction: opts.defaultAction,
    senseResolvers: new Map((opts.senseResolvers ?? []).map((r) => [r.tool, r])),
    terminalSummary: opts.terminalSummary ?? (() => ({})),
    resolveSummary: opts.resolveSummary ?? (() => ({})),
  };
}

// ---- pure readers ----

export function publicView<State>(session: MatchSession<State>): SpectatorView {
  if (!session.projectPublic) throw new Error("public projection unavailable for legacy session");
  return structuredClone(session.projectPublic(session.state));
}

export function publicFrames<State>(session: MatchSession<State>): PublicFrame[] {
  return structuredClone([...session.frames]);
}

export function decisionId<State>(session: MatchSession<State>, seat: SeatId): string {
  return `${session.config.matchId}:${seat}:${session.decisionEpoch}:${session.seatDecisions[seat] ?? 0}`;
}

function recordFrame<State>(session: MatchSession<State>): MatchSession<State> {
  if (!session.projectPublic) return session;
  return {
    ...session,
    frames: [...session.frames, { seq: session.log.length - 1, view: publicView(session) }],
  };
}

export function sessionState<State>(session: MatchSession<State>): State {
  return session.state;
}

export function sessionLog<State>(session: MatchSession<State>): readonly LogEvent[] {
  return session.log;
}

export function isTerminal<State>(session: MatchSession<State>): boolean {
  return session.game.isTerminal(session.state);
}

export function observe<State>(session: MatchSession<State>, seat: SeatId): unknown {
  return ObservationEnvelope.parse(mergedObservation(session, seat));
}

function mergedObservation<State>(
  session: MatchSession<State>,
  seat: SeatId,
): Record<string, unknown> {
  const partial = session.game.observe(session.state, seat) as Record<string, unknown>;
  const actionOffers = session.game.isTerminal(session.state)
    ? []
    : session.game
        .legalActions(session.state, seat)
        .map((spec) => ({ ...spec, description: spec.description ?? spec.tool }));
  const legalTools = actionOffers.map((spec) => spec.tool);
  const budgets: Record<string, number> = {};
  const current = openTurn(session, seat, session.currentPhase(session.state));
  for (const key of BUDGET_KEYS) budgets[key] = remaining(current.budgets, seat, key);
  return { ...partial, legalTools, actionOffers, decisionId: decisionId(session, seat), budgets };
}

// ---- reducer ----

export function step<State>(
  session: MatchSession<State>,
  cmd: Command,
): { session: MatchSession<State>; output: StepOutput } {
  if (!session.config.seats.includes(cmd.seat) || session.game.isTerminal(session.state)) {
    return { session, output: { ok: false, reason: "unknown seat or terminal match" } };
  }
  return cmd.kind === "commitDefault"
    ? commitDefault(session, cmd.seat)
    : callTool(session, cmd.seat, cmd.tool, cmd.input);
}

function openTurn<State>(
  session: MatchSession<State>,
  seat: SeatId,
  phase: string,
): MatchSession<State> {
  const turn = `${session.decisionEpoch}:${phase}`;
  if (session.lastTurnPhase[seat] === turn) return session;
  return {
    ...session,
    budgets: resetTurnBudgets(session.budgets, seat, session.config.budgets),
    lastTurnPhase: { ...session.lastTurnPhase, [seat]: turn },
  };
}

function callTool<State>(
  session: MatchSession<State>,
  seat: SeatId,
  tool: string,
  input: unknown,
): { session: MatchSession<State>; output: StepOutput } {
  const phase = session.currentPhase(session.state);
  if (!session.pm.toolsLegalIn(phase).includes(tool)) {
    return { session, output: { ok: false, reason: `tool ${tool} not legal in phase ${phase}` } };
  }
  const offer = session.game
    .legalActions(session.state, seat)
    .find((action) => action.tool === tool);
  if (!offer)
    return { session, output: { ok: false, reason: `tool ${tool} not legal for seat ${seat}` } };
  const validated = validateSchema(offer.jsonSchema, input);
  if (!validated.ok) {
    return { session, output: { ok: false, reason: `invalid input: ${validated.reason}` } };
  }
  let s = openTurn(session, seat, phase);

  const sense = s.senseResolvers.get(tool);
  if (sense) return serveSense(s, seat, sense, input);

  const spent = spend(s.budgets, seat, "toolCallsPerTurn", 1);
  s = { ...s, budgets: spent.book };
  if (!spent.ok) return { session: s, output: { ok: false, reason: "tool budget exhausted" } };

  const result = s.pm.collect(s.state, seat, tool, input);
  if (result.accepted) {
    s = {
      ...s,
      state: result.state,
      log: appendEvent(s.log, {
        matchId: s.config.matchId,
        phase,
        seat,
        kind: "action.submit",
        payload: { tool, action: input },
      }),
    };
    s = { ...s, seatDecisions: { ...s.seatDecisions, [seat]: (s.seatDecisions[seat] ?? 0) + 1 } };
    s = advanceIfReady(recordFrame(s));
    return { session: s, output: { ok: true, reason: "ok", observation: observe(s, seat) } };
  }

  if (!safeDefaultTriggered(s.budgets, seat)) {
    s = { ...s, budgets: spend(s.budgets, seat, "invalidRetries", 1).book };
    return { session: s, output: { ok: false, reason: result.reason } };
  }
  return commitDefault(s, seat);
}

function commitDefault<State>(
  session: MatchSession<State>,
  seat: SeatId,
): { session: MatchSession<State>; output: StepOutput } {
  const phase = session.currentPhase(session.state);
  let s = openTurn(session, seat, phase);
  const selected = s.defaultAction?.(s.state, seat);
  const fallback = selected ? selected.input : s.safeDefault(s.state, seat);
  const offers = s.game
    .legalActions(s.state, seat)
    .filter(
      (action) =>
        (!selected || action.tool === selected.tool) &&
        !s.senseResolvers.has(action.tool) &&
        validateSchema(action.jsonSchema, fallback).ok,
    );
  // Legacy raw-input callbacks are accepted only when identity is unambiguous.
  const offer = offers.length === 1 ? offers[0] : undefined;
  if (!offer) return { session, output: { ok: false, reason: "no legal safe default" } };
  // Bypass pm.collect's tool-legality gate: a server-internal forced commit
  // (clock expired), not a player tool call. submit() is the correct boundary
  // — same as the replay verifier.
  const def = s.game.submit(s.state, seat, fallback, offer.tool);
  // A rejected default changed nothing, so nothing is logged: the log only ever
  // carries actions the game accepted, which is what replay verification replays.
  if (!def.accepted) {
    return { session, output: { ok: false, reason: `safe default rejected: ${def.reason}` } };
  }
  s = {
    ...s,
    state: def.state,
    log: appendEvent(s.log, {
      matchId: s.config.matchId,
      phase,
      seat,
      kind: "action.default",
      payload: { tool: offer.tool, action: fallback },
    }),
  };
  s = { ...s, seatDecisions: { ...s.seatDecisions, [seat]: (s.seatDecisions[seat] ?? 0) + 1 } };
  s = advanceIfReady(recordFrame(s));
  return { session: s, output: { ok: true, reason: "safe default committed" } };
}

function serveSense<State>(
  session: MatchSession<State>,
  seat: SeatId,
  resolver: SenseResolver<State>,
  input: unknown,
): { session: MatchSession<State>; output: StepOutput } {
  const cost = resolver.cost(input);
  const spent = spend(session.budgets, seat, resolver.budgetKey, cost);
  if (!spent.ok) {
    return { session, output: { ok: false, reason: `${resolver.budgetKey}-exhausted` } };
  }
  // matchRng is only ever forked here (never drawn), so it stays effectively
  // immutable across the match — every fork reads the same initial word-state.
  const rng = session.matchRng.fork(`sense:${resolver.tool}:${seat}:${session.senseSeq}`);
  const { result, nextState } = resolver.resolve(session.state, seat, input, rng);
  let s: MatchSession<State> = {
    ...session,
    budgets: spent.book,
    senseSeq: session.senseSeq + 1,
    state: nextState,
  };
  s = {
    ...s,
    log: appendEvent(s.log, {
      matchId: s.config.matchId,
      phase: s.currentPhase(s.state),
      seat,
      kind: "sense.serve",
      payload: { tool: resolver.tool, cost },
    }),
  };
  return {
    session: recordFrame(s),
    output: { ok: true, reason: "sensing served", observation: observe(s, seat), result },
  };
}

function advanceIfReady<State>(session: MatchSession<State>): MatchSession<State> {
  if (session.game.isTerminal(session.state)) return finalizeTerminal(session);
  if (!session.pm.ready(session.state)) return session;
  const phase = session.currentPhase(session.state);
  let s: MatchSession<State> = {
    ...session,
    state: session.pm.resolve(session.state),
    decisionEpoch: session.decisionEpoch + 1,
    seatDecisions: {},
  };
  s = {
    ...s,
    log: appendEvent(s.log, {
      matchId: s.config.matchId,
      phase,
      seat: null,
      kind: "phase.resolve",
      payload: { ...s.resolveSummary(s.state, phase) },
    }),
  };
  if (s.game.isTerminal(s.state)) return finalizeTerminal(s);
  return advanceIfReady(recordFrame(s));
}

function finalizeTerminal<State>(session: MatchSession<State>): MatchSession<State> {
  let s = session;
  if (s.game.isTerminal(s.state) && !s.terminalWritten) {
    s = { ...s, terminalWritten: true };
    s = {
      ...s,
      log: appendEvent(s.log, {
        matchId: s.config.matchId,
        phase: "terminal",
        seat: null,
        kind: "rng.reveal",
        payload: { seed: s.seed },
      }),
    };
    s = {
      ...s,
      log: appendEvent(s.log, {
        matchId: s.config.matchId,
        phase: "terminal",
        seat: null,
        kind: "match.terminal",
        payload: {
          score: s.game.score(s.state),
          ...s.terminalSummary(s.state),
          config: s.config,
          ...(s.projectPublic ? { result: publicView(s).result } : {}),
        },
      }),
    };
    return recordFrame(s);
  }
  return s;
}

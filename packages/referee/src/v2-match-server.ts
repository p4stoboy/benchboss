import {
  type CurrentMatchConfig,
  type SeatId,
  appendEvent,
  createPhaseMachine,
  createRng,
  initResourceBook,
  resetResources,
  resourceBalances,
  sha256Commit,
  spendResource as spend,
} from "@benchboss/core";
import {
  type ClockSnapshot,
  type HostEvent,
  type Participation,
  type SpectatorView,
  isResourceAmount,
  validateMetering,
  validateParticipation,
  validateSchema,
  validateTimingPolicy,
} from "@benchboss/protocol";
import { ObservationEnvelope } from "@benchboss/schemas";
import type { MatchSession as LegacyMatchSession } from "./legacy-match-server";
import type { Command, SessionOptions, StepOutput } from "./match-server";
import type { AnySenseResolver } from "./sense-resolver";

interface Runtime {
  at: number | null;
  phaseName: string;
  phaseDeadline: number | null;
  remaining: Readonly<Record<SeatId, number | null>>;
  decisionElapsed: Readonly<Record<SeatId, number>>;
  participants: Readonly<Record<SeatId, Participation>>;
  finished: Readonly<Record<SeatId, string>>;
}
export interface CurrentMatchSession<State> extends Omit<LegacyMatchSession<State>, "config"> {
  config: CurrentMatchConfig;
  runtimeV2: Runtime;
  participationHook?: (state: State, seat: SeatId) => Participation;
  hostEventHook?: (state: State, event: HostEvent) => State;
}
type Transition<State> = { session: CurrentMatchSession<State>; output: StepOutput };
const phaseIdentity = <State>(session: CurrentMatchSession<State>) =>
  `${session.config.matchId}:${session.decisionEpoch}`;
const failed = <State>(session: CurrentMatchSession<State>, reason: string): Transition<State> => ({
  session,
  output: { ok: false, reason },
});
const terminal = <State>(session: CurrentMatchSession<State>) =>
  session.game.isTerminal(session.state);

export function newCurrentSession<State>(
  options: SessionOptions<State>,
): CurrentMatchSession<State> {
  if (options.config.timing === undefined || options.config.identity?.protocolVersion !== 2)
    throw Error("invalid v2 configuration");
  const config = structuredClone(options.config);
  for (const validation of [
    validateTimingPolicy(config.timing),
    validateMetering(config.metering, config.resources),
  ]) {
    if (!validation.ok) throw Error(validation.reason);
  }
  if (config.identity.runtimeVersion !== "0.2.0") throw Error("unsupported v2 runtime version");
  if (config.timing.playerTotalMs !== null && !options.onHostEvent)
    throw Error("player-total timing requires an exhaustion handler");
  const state = options.game.newMatch(config, options.seed);
  const phase = options.currentPhase(state);
  const log = appendEvent([], {
    matchId: config.matchId,
    phase: "init",
    seat: null,
    kind: "rng.commit",
    payload: { hash: sha256Commit(options.seed) },
  });
  const s: CurrentMatchSession<State> = {
    projectPublic: options.publicView,
    frames: [],
    decisionEpoch: 0,
    seatDecisions: {},
    game: options.game,
    config,
    seed: options.seed,
    state,
    senseSeq: 0,
    terminalWritten: false,
    lastTurnPhase: {},
    budgets: initResourceBook(config.seats, config.resources),
    log,
    matchRng: createRng(options.seed),
    pm: createPhaseMachine(
      options.game,
      options.phaseToTools,
      options.currentPhase,
      options.isReady,
    ),
    currentPhase: options.currentPhase,
    safeDefault: options.safeDefault,
    defaultAction: options.defaultAction,
    senseResolvers: new Map(
      (options.senseResolvers ?? []).map((resolver) => [resolver.tool, resolver]),
    ),
    terminalSummary: options.terminalSummary ?? (() => ({})),
    resolveSummary: options.resolveSummary ?? (() => ({})),
    participationHook: options.participation,
    hostEventHook: options.onHostEvent,
    runtimeV2: {
      at: null,
      phaseName: phase,
      phaseDeadline: null,
      remaining: Object.fromEntries(
        config.seats.map((seat) => [seat, config.timing.playerTotalMs]),
      ),
      decisionElapsed: {},
      participants: {},
      finished: {},
    },
  };
  return recordFrame(refreshParticipation(s));
}

function append<State>(
  session: CurrentMatchSession<State>,
  kind: string,
  payload: Record<string, unknown>,
  seat: SeatId | null = null,
  phase = session.currentPhase(session.state),
): CurrentMatchSession<State> {
  return {
    ...session,
    log: appendEvent(session.log, {
      matchId: session.config.matchId,
      phase,
      seat,
      kind,
      payload: structuredClone(payload),
    }),
  };
}
function refreshParticipation<State>(
  session: CurrentMatchSession<State>,
): CurrentMatchSession<State> {
  const finished = { ...session.runtimeV2.finished };
  const participants: Record<SeatId, Participation> = {};
  for (const seat of session.config.seats) {
    const value =
      finished[seat] !== undefined
        ? { status: "finished" as const, reason: finished[seat] }
        : terminal(session)
          ? { status: "finished" as const, reason: "match_over" }
          : (session.participationHook?.(session.state, seat) ?? {
              status: session.game
                .legalActions(session.state, seat)
                .some((offer) => !session.senseResolvers.has(offer.tool))
                ? ("acting" as const)
                : ("waiting" as const),
            });
    if (!validateParticipation(value).ok) throw Error("invalid participation");
    participants[seat] = value;
    if (value.status === "finished") finished[seat] = value.reason;
  }
  return { ...session, runtimeV2: { ...session.runtimeV2, participants, finished } };
}
export function currentParticipation<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
): Participation {
  if (!session.config.seats.includes(seat)) return { status: "waiting" };
  return refreshParticipation(session).runtimeV2.participants[seat] ?? { status: "waiting" };
}
function minimum(values: (number | null)[]): number | null {
  const enabled = values.filter((value): value is number => value !== null);
  return enabled.length ? Math.min(...enabled) : null;
}
export function currentClockSnapshot<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
): ClockSnapshot {
  const {
    runtimeV2: clock,
    config: { timing },
  } = session;
  const running = currentParticipation(session, seat).status === "acting" && !terminal(session);
  const at = clock.at ?? 0;
  const remainingMs = clock.remaining[seat] ?? null;
  const decisionRemaining =
    timing.decisionLimitMs === null
      ? null
      : Math.max(0, timing.decisionLimitMs - (clock.decisionElapsed[seat] ?? 0));
  return {
    sampledAt: at,
    remainingMs,
    running,
    deadline: running
      ? minimum([
          remainingMs === null ? null : at + remainingMs,
          decisionRemaining === null ? null : at + decisionRemaining,
          clock.phaseDeadline,
        ])
      : null,
    phaseId: phaseIdentity(session),
    phaseDeadline: terminal(session) ? null : clock.phaseDeadline,
  };
}
export function observeCurrent<State>(session: CurrentMatchSession<State>, seat: SeatId): unknown {
  const partial = session.game.observe(session.state, seat) as Record<string, unknown>;
  const status = currentParticipation(session, seat);
  const actionOffers =
    status.status === "finished"
      ? []
      : session.game
          .legalActions(session.state, seat)
          .filter((offer) => status.status === "acting" || session.senseResolvers.has(offer.tool))
          .map((offer) => ({ ...offer, description: offer.description ?? offer.tool }));
  const { budgets: _legacyBudgets, ...observation } = partial;
  return ObservationEnvelope.parse({
    ...observation,
    protocolVersion: 2,
    phaseId: phaseIdentity(session),
    legalTools: actionOffers.map((offer) => offer.tool),
    actionOffers,
    decisionId: `${session.config.matchId}:${seat}:${session.decisionEpoch}:${session.seatDecisions[seat] ?? 0}`,
    resources: resourceBalances(session.budgets, seat, session.config.resources),
    participation: status,
    clock: currentClockSnapshot(session, seat),
  });
}
export function publicViewCurrent<State>(session: CurrentMatchSession<State>): SpectatorView {
  if (!session.projectPublic) throw Error("public projection unavailable");
  // Timing/resources are runtime-owned: game projectors cannot override their privacy.
  const {
    clocks: _projectedClocks,
    resources: _projectedResources,
    ...view
  } = structuredClone(session.projectPublic(session.state));
  const resources = Object.fromEntries(
    session.config.seats.map((seat) => [
      seat,
      resourceBalances(session.budgets, seat, session.config.resources, "public"),
    ]),
  );
  return {
    ...view,
    ...(session.config.timing.clockVisibility === "public"
      ? {
          clocks: Object.fromEntries(
            session.config.seats.map((seat) => [seat, currentClockSnapshot(session, seat)]),
          ),
        }
      : {}),
    ...(Object.values(session.config.resources).some((resource) => resource.visibility === "public")
      ? { resources }
      : {}),
  };
}
function recordFrame<State>(session: CurrentMatchSession<State>): CurrentMatchSession<State> {
  return session.projectPublic
    ? {
        ...session,
        frames: [
          ...session.frames,
          { seq: session.log.length - 1, view: publicViewCurrent(session) },
        ],
      }
    : session;
}
function resetDecision<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
): CurrentMatchSession<State> {
  return {
    ...session,
    seatDecisions: { ...session.seatDecisions, [seat]: (session.seatDecisions[seat] ?? 0) + 1 },
    budgets: resetResources(session.budgets, seat, session.config.resources, "decision"),
    runtimeV2: {
      ...session.runtimeV2,
      decisionElapsed: { ...session.runtimeV2.decisionElapsed, [seat]: 0 },
    },
  };
}
function beginPhase<State>(session: CurrentMatchSession<State>): CurrentMatchSession<State> {
  const phase = session.currentPhase(session.state);
  const limit = session.config.timing.phaseLimits[phase];
  let budgets = session.budgets;
  for (const seat of session.config.seats)
    budgets = resetResources(budgets, seat, session.config.resources, "phase");
  let s = {
    ...session,
    budgets,
    decisionEpoch: session.decisionEpoch + 1,
    seatDecisions: {},
    runtimeV2: {
      ...session.runtimeV2,
      phaseName: phase,
      phaseDeadline:
        !terminal(session) && limit && session.runtimeV2.at !== null
          ? session.runtimeV2.at + limit.durationMs
          : null,
      decisionElapsed: {},
    },
  };
  s = append(s, "phase.begin", {
    phaseId: phaseIdentity(s),
    deadline: s.runtimeV2.phaseDeadline,
    resources: s.budgets,
  });
  return refreshParticipation(s);
}
function settle<State>(
  session: CurrentMatchSession<State>,
  forcePhase = false,
): CurrentMatchSession<State> {
  let s = refreshParticipation(session);
  let forceResolution = forcePhase;
  if (s.currentPhase(s.state) !== s.runtimeV2.phaseName) s = beginPhase(s);
  for (let count = 0; !terminal(s); count++) {
    if (count >= 10000) throw Error("phase resolution exceeded progress bound");
    const policy = s.config.timing.phaseLimits[s.currentPhase(s.state)];
    if (!forceResolution && (policy?.close === "deadline" || !s.pm.ready(s.state))) break;
    const phase = s.currentPhase(s.state);
    const before = canonical(s.state);
    s = { ...s, state: s.pm.resolve(s.state) };
    if (canonical(s.state) === before) throw Error("phase resolution made no progress");
    s = append(s, "phase.resolve", { ...s.resolveSummary(s.state, phase) }, null, phase);
    s = beginPhase(s);
    forceResolution = false;
  }
  return refreshParticipation(s);
}
function initializeTime<State>(
  session: CurrentMatchSession<State>,
  at: number,
): CurrentMatchSession<State> {
  const limit = session.config.timing.phaseLimits[session.currentPhase(session.state)];
  return refreshParticipation({
    ...session,
    runtimeV2: {
      ...session.runtimeV2,
      at,
      phaseDeadline: limit && !terminal(session) ? at + limit.durationMs : null,
    },
  });
}
function advanceClock<State>(
  session: CurrentMatchSession<State>,
  at: number,
): CurrentMatchSession<State> {
  const from = session.runtimeV2.at ?? at;
  const elapsed = at - from;
  const remaining = { ...session.runtimeV2.remaining };
  const decisionElapsed = { ...session.runtimeV2.decisionElapsed };
  const spent: Record<string, number> = {};
  for (const seat of session.config.seats) {
    if (session.runtimeV2.participants[seat]?.status !== "acting") continue;
    if (remaining[seat] !== null && remaining[seat] !== undefined)
      remaining[seat] = Math.max(0, remaining[seat] - elapsed);
    decisionElapsed[seat] = (decisionElapsed[seat] ?? 0) + elapsed;
    spent[seat] = elapsed;
  }
  return append(
    { ...session, runtimeV2: { ...session.runtimeV2, at, remaining, decisionElapsed } },
    "clock.advance",
    { from, to: at, spent },
  );
}
function actingSeats<State>(session: CurrentMatchSession<State>): SeatId[] {
  return session.config.seats
    .filter((seat) => session.runtimeV2.participants[seat]?.status === "acting")
    .sort();
}
function event<State>(
  session: CurrentMatchSession<State>,
  kind: HostEvent["kind"],
  seats: SeatId[],
): CurrentMatchSession<State> {
  const hostEvent: HostEvent = {
    kind,
    seats: [...seats].sort(),
    phaseId: phaseIdentity(session),
    at: session.runtimeV2.at ?? 0,
  };
  let s = append(session, "host.event", { ...hostEvent });
  const before = canonical(s.state);
  if (s.hostEventHook) s = { ...s, state: s.hostEventHook(s.state, hostEvent) };
  s = refreshParticipation(s);
  if (kind === "player_time_exhausted") {
    if (seats.some((seat) => s.runtimeV2.participants[seat]?.status !== "finished") && !terminal(s))
      throw Error("exhausted seat must finish or end the match");
    return settle(s);
  }
  if (canonical(s.state) !== before) {
    if (kind === "phase_expired" && s.currentPhase(s.state) === s.runtimeV2.phaseName)
      s = beginPhase(s);
    if (kind !== "phase_expired") for (const seat of seats) s = resetDecision(s, seat);
    return settle(s);
  }
  // A direct submit may enter a new phase before game.step. Its actors must get
  // their own deadline rather than consuming the previous phase's expiry batch.
  const expiredPhase = s.currentPhase(s.state);
  for (const seat of seats) {
    if (terminal(s)) break;
    if (s.runtimeV2.participants[seat]?.status !== "acting") continue;
    const applied = applyDefault(s, seat);
    if (!applied.output.ok) throw Error(applied.output.reason);
    s = refreshParticipation(applied.session);
    if (s.currentPhase(s.state) !== expiredPhase) break;
  }
  return settle(s, kind === "phase_expired" && s.currentPhase(s.state) === expiredPhase);
}
function advanceTime<State>(
  session: CurrentMatchSession<State>,
  at: number,
): CurrentMatchSession<State> {
  if (session.runtimeV2.at === null) return settle(initializeTime(session, at));
  let s = settle(session);
  for (let count = 0; !terminal(s); count++) {
    if (count >= 10000) throw Error("clock expiry exceeded progress bound");
    const actors = actingSeats(s);
    const due = minimum([
      s.runtimeV2.phaseDeadline,
      ...actors.map((seat) => currentClockSnapshot(s, seat).deadline),
    ]);
    if (due === null || due > at) return advanceClock(s, at);
    s = advanceClock(s, due);
    const exhausted = actors.filter((seat) => s.runtimeV2.remaining[seat] === 0);
    if (exhausted.length) {
      s = event(s, "player_time_exhausted", exhausted);
      continue;
    }
    if (s.runtimeV2.phaseDeadline !== null && s.runtimeV2.phaseDeadline <= due) {
      s = event(s, "phase_expired", actingSeats(s));
      continue;
    }
    const decisionExpired = actors.filter(
      (seat) =>
        s.config.timing.decisionLimitMs !== null &&
        (s.runtimeV2.decisionElapsed[seat] ?? 0) >= s.config.timing.decisionLimitMs,
    );
    if (decisionExpired.length) {
      s = event(s, "decision_expired", decisionExpired);
      continue;
    }
    throw Error("clock expiry made no progress");
  }
  return s;
}
function validateCharge<State>(
  session: CurrentMatchSession<State>,
  resource: string,
  cost: number,
): void {
  if (!Object.hasOwn(session.config.resources, resource) || !isResourceAmount(cost))
    throw Error("invalid resource charge");
}
function charge<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
  resource: string,
  cost: number,
  purpose: string,
): { session: CurrentMatchSession<State>; ok: boolean } {
  validateCharge(session, resource, cost);
  const spent = spend(session.budgets, seat, resource, cost);
  return {
    session: append(
      { ...session, budgets: spent.book },
      "resource.spend",
      { resource, cost, purpose, ok: spent.ok, remaining: spent.book[seat]?.[resource] },
      seat,
    ),
    ok: spent.ok,
  };
}
function applyDefault<State>(session: CurrentMatchSession<State>, seat: SeatId): Transition<State> {
  if (currentParticipation(session, seat).status !== "acting")
    return failed(session, "seat is not acting");
  const selected = session.defaultAction?.(session.state, seat);
  const input = selected ? selected.input : session.safeDefault(session.state, seat);
  const offers = session.game
    .legalActions(session.state, seat)
    .filter(
      (offer) =>
        (!selected || offer.tool === selected.tool) &&
        !session.senseResolvers.has(offer.tool) &&
        validateSchema(offer.jsonSchema, input).ok,
    );
  const offer = offers.length === 1 ? offers[0] : undefined;
  if (!offer) return failed(session, "no legal safe default");
  const result = session.game.submit(session.state, seat, input, offer.tool);
  if (!result.accepted) return failed(session, `safe default rejected: ${result.reason}`);
  return {
    session: resetDecision(
      append(
        { ...session, state: result.state },
        "action.default",
        { tool: offer.tool, action: input },
        seat,
        session.currentPhase(session.state),
      ),
      seat,
    ),
    output: { ok: true, reason: "safe default committed" },
  };
}
function serveSense<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
  resolver: AnySenseResolver<State>,
  input: unknown,
  cost: number,
): Transition<State> {
  if (!("resource" in resolver)) throw Error("v2 sensing requires a named resource");
  const charged = charge(session, seat, resolver.resource, cost, "sense");
  if (!charged.ok) return failed(charged.session, `${resolver.resource}-exhausted`);
  const rng = session.matchRng.fork(`sense:${resolver.tool}:${seat}:${session.senseSeq}`);
  const { result, nextState } = resolver.resolve(session.state, seat, input, rng);
  const s = append(
    { ...charged.session, state: nextState, senseSeq: session.senseSeq + 1 },
    "sense.serve",
    { tool: resolver.tool, resource: resolver.resource, cost },
    seat,
  );
  return { session: s, output: { ok: true, reason: "sensing served", result } };
}
interface PreparedCall<State> {
  sense?: { resolver: AnySenseResolver<State>; cost: number };
}
function prepareCall<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
  tool: string,
  input: unknown,
): { ok: true; prepared: PreparedCall<State> } | { ok: false; reason: string } {
  const phase = session.currentPhase(session.state);
  if (!session.pm.toolsLegalIn(phase).includes(tool))
    return { ok: false, reason: `tool ${tool} not legal in phase ${phase}` };
  const offer = session.game.legalActions(session.state, seat).find((value) => value.tool === tool);
  if (!offer) return { ok: false, reason: `tool ${tool} not legal for seat ${seat}` };
  const valid = validateSchema(offer.jsonSchema, input);
  if (!valid.ok) return { ok: false, reason: `invalid input: ${valid.reason}` };
  const resolver = session.senseResolvers.get(tool);
  if (resolver) {
    if (!("resource" in resolver)) throw Error("v2 sensing requires a named resource");
    const cost = resolver.cost(input);
    validateCharge(session, resolver.resource, cost);
    if (!spend(session.budgets, seat, resolver.resource, cost).ok)
      return { ok: false, reason: `${resolver.resource}-exhausted` };
    return { ok: true, prepared: { sense: { resolver, cost } } };
  }
  if (currentParticipation(session, seat).status !== "acting")
    return { ok: false, reason: "seat is not acting" };
  const metering = session.config.metering.action;
  if (metering && !spend(session.budgets, seat, metering.resource, metering.cost).ok)
    return { ok: false, reason: `${metering.resource}-exhausted` };
  return { ok: true, prepared: {} };
}
function callTool<State>(
  session: CurrentMatchSession<State>,
  seat: SeatId,
  tool: string,
  input: unknown,
  prepared: PreparedCall<State>,
): Transition<State> {
  const phase = session.currentPhase(session.state);
  if (prepared.sense)
    return serveSense(session, seat, prepared.sense.resolver, input, prepared.sense.cost);
  let s = session;
  const metering = s.config.metering;
  if (metering.action) {
    const charged = charge(s, seat, metering.action.resource, metering.action.cost, "action");
    s = charged.session;
    if (!charged.ok) return failed(s, `${metering.action.resource}-exhausted`);
  }
  const submitted = s.pm.collect(s.state, seat, tool, input);
  if (submitted.accepted) {
    s = resetDecision(
      append(
        { ...s, state: submitted.state },
        "action.submit",
        { tool, action: input },
        seat,
        phase,
      ),
      seat,
    );
    return { session: s, output: { ok: true, reason: "ok" } };
  }
  s = append(s, "action.reject", { tool, action: input, reason: submitted.reason }, seat);
  if (metering.invalidAction) {
    const charged = charge(
      s,
      seat,
      metering.invalidAction.resource,
      metering.invalidAction.cost,
      "invalidAction",
    );
    s = charged.session;
    if (!charged.ok)
      return {
        session: event(s, "invalid_retries_exhausted", [seat]),
        output: { ok: true, reason: "safe default committed" },
      };
  }
  return failed(s, submitted.reason);
}
function finishCommand<State>(
  session: CurrentMatchSession<State>,
  output: StepOutput,
  command: Command,
): Transition<State> {
  let s = settle(session);
  s = append(s, "command.result", {
    ok: output.ok,
    reason: output.reason,
  });
  s = append(s, "clock.state", {
    clocks: Object.fromEntries(s.config.seats.map((seat) => [seat, currentClockSnapshot(s, seat)])),
    participation: s.runtimeV2.participants,
    resources: s.budgets,
  });
  if (terminal(s) && !s.terminalWritten) {
    s = { ...s, terminalWritten: true };
    s = append(s, "rng.reveal", { seed: s.seed }, null, "terminal");
    s = append(
      s,
      "match.terminal",
      {
        score: s.game.score(s.state),
        ...s.terminalSummary(s.state),
        config: s.config,
        ...(s.projectPublic ? { result: publicViewCurrent(s).result } : {}),
      },
      null,
      "terminal",
    );
  }
  s = recordFrame(s);
  return {
    session: s,
    output:
      command.kind === "callTool" && output.ok
        ? { ...output, observation: observeCurrent(s, command.seat) }
        : output,
  };
}
export function stepCurrent<State>(
  session: CurrentMatchSession<State>,
  command: Command,
): Transition<State> {
  if (terminal(session)) return failed(session, "unknown seat or terminal match");
  if (command.kind !== "advanceTime" && !session.config.seats.includes(command.seat))
    return failed(session, "unknown seat or terminal match");
  if (
    command.kind === "advanceTime" &&
    (!Number.isSafeInteger(command.at) ||
      command.at < 0 ||
      (session.runtimeV2.at !== null && command.at < session.runtimeV2.at))
  )
    return failed(session, "time must be a monotonic nonnegative safe integer");
  if (command.kind === "advanceTime") {
    if (command.at === session.runtimeV2.at)
      return { session, output: { ok: true, reason: "time advanced" } };
    const recorded = append(refreshParticipation(session), "command", { ...command });
    return finishCommand(
      advanceTime(recorded, command.at),
      { ok: true, reason: "time advanced" },
      command,
    );
  }
  if (currentParticipation(session, command.seat).status === "finished")
    return failed(session, "seat finished");
  if (
    command.kind === "commitDefault" &&
    currentParticipation(session, command.seat).status !== "acting"
  )
    return failed(session, "seat is not acting");
  // No-op rejections retain no caller payload or frame. The host's preceding
  // advanceTime command already accounts for their elapsed time. Only calls
  // admitted to metered execution are replay commands.
  const preparation =
    command.kind === "callTool"
      ? prepareCall(session, command.seat, command.tool, command.input)
      : { ok: true as const, prepared: {} };
  if (!preparation.ok) return failed(session, preparation.reason);
  let s = refreshParticipation(session);
  // Hosts establish epoch time first; direct low-level execution uses zero.
  if (s.runtimeV2.at === null) s = initializeTime(s, 0);
  s = append(s, "command", { ...command });
  const result =
    command.kind === "commitDefault"
      ? applyDefault(s, command.seat)
      : callTool(s, command.seat, command.tool, command.input, preparation.prepared);
  return finishCommand(result.session, result.output, command);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

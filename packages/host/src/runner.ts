import { type SeatId, eventsToJsonl } from "@benchboss/core";
import type { ReplayPresentation, SpectatorView, SubmissionIdentity } from "@benchboss/protocol";
import {
  decisionId,
  isTerminal,
  observe,
  publicFrames,
  publicView,
  sessionLog,
} from "@benchboss/referee";
import { type GameBinding, type MatchSpec, createMatchServer } from "./games";

import type { GameRegistry } from "./registry";

export interface SubmitResult {
  ok: boolean;
  reason: string;
  observation?: unknown;
  result?: Record<string, unknown>;
}

export type NextEnvelope =
  | { kind: "turn"; matchId: string; seat: SeatId; observation: unknown; deadline: number }
  | { kind: "match_over"; matchId: string; result: Record<SeatId, number> }
  | { kind: "match_aborted"; matchId: string; reason: AbortReason }
  | { kind: "idle" };

export type AbortReason = "game_error" | "server_restart" | "server_shutdown";
export interface MatchAbortion {
  matchId: string;
  gameId: string;
  reason: AbortReason;
  startedAt: string;
  endedAt: string;
  seats: { seat: SeatId; agentId: string }[];
}

export interface MatchArtifact {
  record: {
    id: string;
    gameId: string;
    seed: string;
    config: MatchSpec["config"];
    result: Record<SeatId, number>;
    startedAt: string;
    endedAt: string;
    presentation?: ReplayPresentation;
  };
  replayJsonl: string;
  seats: { seat: SeatId; agentId: string; score: number | null }[];
}

export interface RunnerDeps {
  persist: (artifact: MatchArtifact) => Promise<void>;
  onComplete?: (artifact: MatchArtifact) => Promise<void>;
  // Opt in only when the callback commits effects idempotently by match ID.
  retryCompletion?: boolean;
  persistAborted?: (abortion: MatchAbortion) => Promise<void>;
  registry: GameRegistry;
  now?: () => number;
  maxHoldMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ActiveMatch {
  spec: MatchSpec;
  binding: GameBinding;
  seatByPrincipal: Map<string, SeatId>;
  seatToAgent: Record<SeatId, string>;
  deadline: Map<SeatId, number | null>;
  clockDecision: Map<SeatId, string>;
  aborted?: MatchAbortion;
  acknowledgedOver: Set<SeatId>;
  perDecisionMs: number;
  startedAt: string;
  endedAt: string | null;
  persisted?: boolean;
  finalizing?: Promise<void>;
  finalization: "pending" | "complete" | "persistence_failed" | "completion_failed";
  artifact?: MatchArtifact;
  over: boolean;
  result: Record<SeatId, number> | null;
}

// Public-safe projection of a live match: names, phase, clocks. Never game state —
// the referee has no spectator seat and every observation is seat-scoped.
export interface LiveSeat {
  seat: SeatId;
  agentId: string;
  principalId: string; // opaque host adapter identifier; strip before responding
  deadline: number | null;
}

export interface LiveMatchSummary {
  matchId: string;
  gameId: string;
  phase: string;
  startedAt: string;
  seats: LiveSeat[];
}

export interface OpsMatch extends LiveMatchSummary {
  abortReason?: AbortReason;
  finalization: "pending" | "complete" | "persistence_failed" | "completion_failed";
  over: boolean;
  endedAt: string | null;
  result: Record<SeatId, number> | null;
  perDecisionMs: number;
  acknowledgedOver: SeatId[];
}

export interface MatchRunner {
  start(spec: MatchSpec): void;
  submit(
    principalId: string,
    matchId: string,
    tool: string,
    input: unknown,
    identity?: SubmissionIdentity,
  ): Promise<SubmitResult>;
  view(matchId: string): SpectatorView | null;
  poll(principalId: string): NextEnvelope;
  next(principalId: string): Promise<NextEnvelope>;
  reap(): Promise<void>;
  abort(matchId: string, reason: AbortReason): Promise<void>;
  acknowledge(principalId: string, matchId: string): void;
  // Matches still in play.
  list(): LiveMatchSummary[];
  // Everything the runner holds, finished matches included. Operator use only.
  inspect(): OpsMatch[];
}

// A factory, not a class: `createMatchRunner` closes over the match registry and
// deps and returns a plain object of functions. It binds `matches`, `now`, the
// long-poll knobs (`maxHoldMs`/`pollIntervalMs`/`sleep`), and `finalize`, which
// persists the terminal match + replay through `deps.persist`, then invokes optional completion policy.
export function createMatchRunner(deps: RunnerDeps): MatchRunner {
  const matches = new Map<string, ActiveMatch>();
  const now = deps.now ?? (() => Date.now());
  const maxHoldMs = deps.maxHoldMs ?? 25000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pending = new Map<string, Promise<void>>();
  function serialize<T>(matchId: string, action: () => Promise<T>): Promise<T> {
    const response = (pending.get(matchId) ?? Promise.resolve()).then(action);
    const tail = response.then(
      () => undefined,
      () => undefined,
    );
    pending.set(matchId, tail);
    void tail.then(() => {
      if (pending.get(matchId) === tail) pending.delete(matchId);
    });
    return response;
  }

  function syncClocks(match: ActiveMatch, at: number): void {
    const session = match.binding.handle.get();
    for (const seat of Object.keys(match.seatToAgent) as SeatId[]) {
      const actionable =
        !match.over &&
        !isTerminal(session) &&
        session.game
          .legalActions(session.state, seat)
          .some((offer) => !session.senseResolvers.has(offer.tool));
      if (!actionable) {
        match.deadline.set(seat, null);
        match.clockDecision.delete(seat);
        continue;
      }
      const id = decisionId(session, seat);
      if (match.clockDecision.get(seat) !== id) {
        match.clockDecision.set(seat, id);
        match.deadline.set(seat, at + match.perDecisionMs);
      }
    }
  }

  function cancel(match: ActiveMatch, reason: AbortReason, at: number): void {
    if (match.over) return;
    match.over = true;
    match.endedAt = new Date(at).toISOString();
    match.aborted = {
      matchId: match.spec.matchId,
      gameId: match.spec.gameId,
      reason,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      seats: match.spec.assignments.map(({ seat, agentId }) => ({ seat, agentId })),
    };
    for (const seat of match.deadline.keys()) match.deadline.set(seat, null);
    match.clockDecision.clear();
  }

  const start = (input: MatchSpec): void => {
    const spec = structuredClone(input);
    if (matches.has(spec.matchId)) throw new Error(`duplicate match: ${spec.matchId}`);
    const binding = createMatchServer(deps.registry.resolve(spec.config), spec.config, spec.seed);
    const seatByPrincipal = new Map<string, SeatId>();
    const seatToAgent = {} as Record<SeatId, string>;
    const deadline = new Map<SeatId, number | null>();
    for (const a of spec.assignments) {
      seatByPrincipal.set(a.principalId, a.seat);
      seatToAgent[a.seat] = a.agentId;
      deadline.set(a.seat, null);
    }
    const match: ActiveMatch = {
      spec,
      binding,
      seatByPrincipal,
      seatToAgent,
      deadline,
      clockDecision: new Map(),
      acknowledgedOver: new Set(),
      perDecisionMs: spec.config.budgets.wallClockMsPerDecision,
      startedAt: spec.startedAt ?? new Date(now()).toISOString(),
      endedAt: null,
      finalization: "pending",
      over: false,
      result: null,
    };
    syncClocks(match, now());
    matches.set(spec.matchId, match);
  };

  const execute = async (
    principalId: string,
    matchId: string,
    tool: string,
    input: unknown,
    identity?: SubmissionIdentity,
  ): Promise<SubmitResult> => {
    const match = matches.get(matchId);
    if (!match) return { ok: false, reason: "unknown_match" };
    const seat = match.seatByPrincipal.get(principalId);
    if (!seat) return { ok: false, reason: "not_in_match" };
    const submittedDecision = decisionId(match.binding.handle.get(), seat);
    const deadline = match.deadline.get(seat);
    const expired = deadline != null && now() >= deadline;
    await advanceTime(match, now()).catch(() => undefined);
    if (match.over) return { ok: false, reason: match.aborted ? "match_aborted" : "match_over" };
    if (expired || submittedDecision !== decisionId(match.binding.handle.get(), seat))
      return { ok: false, reason: "deadline_expired" };
    if (identity && identity.decisionId !== decisionId(match.binding.handle.get(), seat))
      return { ok: false, reason: "stale_decision" };
    let res: SubmitResult;
    try {
      res = match.binding.handle.advance({ kind: "callTool", seat, tool, input });
      syncClocks(match, now());
    } catch {
      cancel(match, "game_error", now());
      await finalize(match, now()).catch(() => undefined);
      return { ok: false, reason: "match_aborted" };
    }
    if (isTerminal(match.binding.handle.get()) && !match.over) {
      try {
        await finalize(match, now());
      } catch {
        if (!match.persisted) return { ok: false, reason: "persistence_pending" };
      }
    }
    return res;
  };

  const poll = (principalId: string): NextEnvelope => {
    for (const match of matches.values()) {
      const seat = match.seatByPrincipal.get(principalId);
      if (!seat) continue;
      if (match.over) {
        if (!match.persisted) continue;
        if (match.acknowledgedOver.has(seat)) continue;
        match.acknowledgedOver.add(seat);
        if (match.aborted)
          return {
            kind: "match_aborted",
            matchId: match.spec.matchId,
            reason: match.aborted.reason,
          };
        return { kind: "match_over", matchId: match.spec.matchId, result: match.result ?? {} };
      }
      const obs = observe(match.binding.handle.get(), seat) as { legalTools: string[] };
      const deadline = match.deadline.get(seat) ?? null;
      if (obs.legalTools.length === 0 || deadline === null) continue;
      return { kind: "turn", matchId: match.spec.matchId, seat, observation: obs, deadline };
    }
    return { kind: "idle" };
  };

  const next = async (principalId: string): Promise<NextEnvelope> => {
    const start = now();
    while (true) {
      for (const match of matches.values()) {
        if (match.seatByPrincipal.has(principalId))
          await serialize(match.spec.matchId, () => advanceTime(match, now()));
      }
      const env = poll(principalId);
      if (env.kind !== "idle") return env;
      if (now() - start >= maxHoldMs) return env;
      await sleep(pollIntervalMs);
    }
  };

  async function advanceTime(match: ActiveMatch, at: number): Promise<void> {
    if (!match.over) {
      try {
        const due = [...match.deadline]
          .filter(([, deadline]) => deadline !== null && at >= deadline)
          .map(([seat]) => ({ seat, id: match.clockDecision.get(seat) }));
        for (const { seat, id } of due) {
          if (match.clockDecision.get(seat) !== id || match.deadline.get(seat) == null) continue;
          const result = match.binding.handle.advance({ kind: "commitDefault", seat });
          if (!result.ok) {
            cancel(match, "game_error", at);
            break;
          }
          syncClocks(match, at);
        }
      } catch {
        cancel(match, "game_error", at);
      }
    }
    if (match.over || isTerminal(match.binding.handle.get())) await finalize(match, at);
  }

  const reap = async (): Promise<void> => {
    const outcomes = await Promise.allSettled(
      [...matches.values()].map((match) =>
        serialize(match.spec.matchId, () => advanceTime(match, now())),
      ),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  const complete = async (match: ActiveMatch, nowMs: number): Promise<void> => {
    if (match.aborted) {
      if (match.persisted) return;
      try {
        await deps.persistAborted?.(match.aborted);
        match.persisted = true;
        match.finalization = "complete";
      } catch (error) {
        match.finalization = "persistence_failed";
        throw error;
      }
      return;
    }
    if (!match.artifact) {
      try {
        const result = match.binding.score();
        const endedAt = new Date(nowMs).toISOString();
        const artifact: MatchArtifact = {
          record: {
            id: match.spec.matchId,
            gameId: match.spec.gameId,
            seed: match.spec.seed,
            config: match.spec.config,
            result,
            startedAt: match.startedAt,
            endedAt,
            ...(match.spec.config.identity
              ? {
                  presentation: {
                    identity: match.spec.config.identity,
                    frames: publicFrames(match.binding.handle.get()),
                  },
                }
              : {}),
          },
          replayJsonl: eventsToJsonl(sessionLog(match.binding.handle.get())),
          seats: (Object.keys(match.seatToAgent) as SeatId[]).map((seat) => ({
            seat,
            agentId: match.seatToAgent[seat] as string,
            score: result[seat] ?? null,
          })),
        };
        match.artifact = artifact;
        match.result = result;
        match.endedAt = endedAt;
        match.over = true;
      } catch {
        cancel(match, "game_error", nowMs);
        await complete(match, nowMs);
        return;
      }
    }
    if (match.persisted) {
      if (!deps.retryCompletion || match.finalization !== "completion_failed") return;
    } else {
      try {
        await deps.persist(match.artifact);
      } catch (error) {
        match.finalization = "persistence_failed";
        throw error;
      }
      match.persisted = true;
    }
    try {
      await deps.onComplete?.(match.artifact);
      match.finalization = "complete";
    } catch (error) {
      match.finalization = "completion_failed";
      throw error;
    }
  };

  const finalize = async (match: ActiveMatch, nowMs: number): Promise<void> => {
    if (match.finalizing) return match.finalizing;
    const task = complete(match, nowMs);
    match.finalizing = task;
    try {
      await task;
    } finally {
      match.finalizing = undefined;
    }
  };

  const requests = new Map<string, { body: string; response: Promise<SubmitResult> }>();
  const submit: MatchRunner["submit"] = (principalId, matchId, tool, input, identity) => {
    const key = JSON.stringify([principalId, matchId, identity?.requestId]);
    const body = JSON.stringify([tool, input, identity?.decisionId]);
    if (identity) {
      if (!identity.requestId || !identity.decisionId)
        return Promise.resolve({ ok: false, reason: "bad_request" });
      const prior = requests.get(key);
      if (prior)
        return prior.body === body
          ? prior.response
          : Promise.resolve({ ok: false, reason: "request_conflict" });
    }
    const response = serialize(matchId, () => execute(principalId, matchId, tool, input, identity));
    if (identity) requests.set(key, { body, response });
    return response;
  };

  const summarize = (match: ActiveMatch): LiveMatchSummary => ({
    matchId: match.spec.matchId,
    gameId: match.spec.gameId,
    phase: match.binding.phase(),
    startedAt: match.startedAt,
    seats: match.spec.assignments.map((a) => ({
      seat: a.seat,
      agentId: a.agentId,
      principalId: a.principalId,
      deadline: match.deadline.get(a.seat) ?? null,
    })),
  });

  const list = (): LiveMatchSummary[] =>
    [...matches.values()].filter((m) => !m.over).map(summarize);

  const inspect = (): OpsMatch[] =>
    [...matches.values()].map((m) => ({
      ...summarize(m),
      over: m.over,
      finalization: m.finalization,
      ...(m.aborted ? { abortReason: m.aborted.reason } : {}),
      endedAt: m.endedAt,
      result: m.result,
      perDecisionMs: m.perDecisionMs,
      acknowledgedOver: [...m.acknowledgedOver],
    }));

  return {
    start,
    submit,
    poll,
    next,
    reap,
    abort: (id, reason) =>
      serialize(id, async () => {
        const match = matches.get(id);
        if (!match) return;
        cancel(match, reason, now());
        await finalize(match, now());
      }),
    acknowledge: (principalId, id) => {
      const match = matches.get(id);
      const seat = match?.seatByPrincipal.get(principalId);
      if (match?.over && match.persisted && seat) match.acknowledgedOver.add(seat);
    },
    list,
    inspect,
    view: (id) => {
      const m = matches.get(id);
      return m && !m.aborted ? publicView(m.binding.handle.get()) : null;
    },
  };
}

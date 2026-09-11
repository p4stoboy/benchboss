import type { SeatId } from "@benchboss/core";
import type { GameResult } from "@benchboss/protocol";
import type { MatchSpec } from "./games";
import {
  type ProcessLimits,
  type ProcessTransport,
  createProcessTransport,
  positiveLimit,
} from "./process-transport";
import type { WorkerCommand, WorkerReply, WorkerSnapshot } from "./process-worker";
import { monotonicEpochMs, sampleNext, sampleView } from "./runner";
import type {
  AbortReason,
  MatchAbortion,
  MatchRunner,
  NextEnvelope,
  OpsMatch,
  RunnerDeps,
  SubmitEnvelope,
} from "./runner";

export interface ProcessRunnerOptions extends ProcessLimits {
  maxMatches?: number;
  maxRetainedMatches?: number;
  maxCachedRequests?: number;
  retentionMs?: number;
}
export interface ProcessMatchRunner extends Omit<MatchRunner, "start"> {
  start(spec: MatchSpec): Promise<void>;
}
interface HeldMatch {
  spec: MatchSpec;
  process?: ProcessTransport;
  snapshot?: WorkerSnapshot;
  abortion?: MatchAbortion;
  persisted: boolean;
  finalization: OpsMatch["finalization"];
  completedAt?: number;
  acknowledged: Set<SeatId>;
  acknowledgedFinished: Set<SeatId>;
  tail: Promise<unknown>;
}

export function createProcessMatchRunner(
  deps: RunnerDeps,
  options: ProcessRunnerOptions,
): ProcessMatchRunner {
  const now = deps.now ?? monotonicEpochMs;
  const maxMatches = positiveLimit(options.maxMatches, 16);
  const maxRetained = positiveLimit(options.maxRetainedMatches, 256);
  const maxRequests = positiveLimit(options.maxCachedRequests, 10000);
  const retentionMs = positiveLimit(options.retentionMs, 60000);
  const held = new Map<string, HeldMatch>();
  const receipts = new Map<
    string,
    { body: string; expires: number; response: Promise<SubmitEnvelope> }
  >();
  const over = (m: HeldMatch) => !!m.abortion || m.snapshot?.inspection.over === true;
  const settled = (m: HeldMatch) =>
    m.persisted && (m.finalization === "complete" || !deps.retryCompletion);
  const sweep = () => {
    for (const [id, m] of held)
      if (settled(m) && m.completedAt !== undefined && now() - m.completedAt >= retentionMs)
        held.delete(id);
    for (const [id, receipt] of receipts) if (receipt.expires <= now()) receipts.delete(id);
  };
  const serialize = <T>(m: HeldMatch, action: () => Promise<T>): Promise<T> => {
    const response = m.tail.catch(() => undefined).then(action);
    m.tail = response;
    return response;
  };
  const cancel = (m: HeldMatch, reason: AbortReason) => {
    if (over(m)) return;
    m.abortion = {
      matchId: m.spec.matchId,
      gameId: m.spec.gameId,
      reason,
      startedAt: m.spec.startedAt ?? new Date(now()).toISOString(),
      endedAt: new Date(now()).toISOString(),
      seats: m.spec.assignments.map(({ seat, agentId }) => ({ seat, agentId })),
    };
    m.snapshot = undefined;
  };
  async function finish(m: HeldMatch): Promise<void> {
    if (!over(m)) return;
    if (m.process) {
      await m.process.close();
      m.process = undefined;
    }
    if (!m.persisted) {
      try {
        if (m.abortion) await deps.persistAborted?.(m.abortion);
        else {
          if (!m.snapshot?.artifact) throw Error("missing terminal artifact");
          await deps.persist(m.snapshot.artifact);
        }
        m.persisted = true;
      } catch (error) {
        m.finalization = "persistence_failed";
        throw error;
      }
    }
    if (
      m.finalization === "complete" ||
      (m.finalization === "completion_failed" && !deps.retryCompletion)
    )
      return;
    try {
      if (!m.abortion && m.snapshot?.artifact) await deps.onComplete?.(m.snapshot.artifact);
      m.finalization = "complete";
      m.completedAt = now();
      if (m.snapshot) {
        m.snapshot.artifact = undefined;
        m.snapshot.turns = {};
      }
    } catch (error) {
      m.finalization = "completion_failed";
      throw error;
    }
  }
  async function dispatch(
    m: HeldMatch,
    command: WorkerCommand,
  ): Promise<SubmitEnvelope | undefined> {
    let result: SubmitEnvelope | undefined;
    if (!over(m)) {
      try {
        if (!m.process) throw Error("missing worker");
        const response = await m.process.request<WorkerReply>(
          command.kind === "verify" ? command : { ...command, at: now() },
        );
        const snapshot = response?.snapshot;
        if (
          !snapshot ||
          snapshot.inspection?.matchId !== m.spec.matchId ||
          !snapshot.turns ||
          (snapshot.inspection.over && !snapshot.artifact && !snapshot.abortion)
        )
          throw Error("invalid worker snapshot");
        m.snapshot = snapshot;
        m.abortion = snapshot.abortion;
        result = response.result;
      } catch {
        cancel(m, "game_error");
        result = { protocolVersion: 1, ok: false, reason: "match_aborted" };
      }
    }
    try {
      await finish(m);
    } catch {
      if (!m.persisted) return { protocolVersion: 1, ok: false, reason: "persistence_pending" };
    }
    return result;
  }
  const summarize = (m: HeldMatch): OpsMatch => ({
    matchId: m.spec.matchId,
    gameId: m.spec.gameId,
    startedAt: m.spec.startedAt ?? "",
    phase: m.abortion ? "aborted" : (m.snapshot?.inspection.phase ?? "starting"),
    seats: m.spec.assignments.map((s) => ({
      ...s,
      deadline: over(m)
        ? null
        : (m.snapshot?.inspection.seats.find((row) => row.seat === s.seat)?.deadline ?? null),
    })),
    over: over(m),
    finalization: m.finalization,
    abortReason: m.abortion?.reason,
    endedAt: m.abortion?.endedAt ?? m.snapshot?.inspection.endedAt ?? null,
    result: m.persisted ? (m.snapshot?.inspection.result ?? null) : null,
    perDecisionMs: m.spec.config.timing.decisionLimitMs,
    acknowledgedOver: [...m.acknowledged],
  });
  const poll = (principal: string, options: { acknowledge?: boolean } = {}): NextEnvelope => {
    sweep();
    for (const m of held.values()) {
      const seat = m.spec.assignments.find((s) => s.principalId === principal)?.seat;
      if (!seat) continue;
      if (over(m)) {
        if (!m.persisted || m.acknowledged.has(seat)) continue;
        if (options.acknowledge !== false) m.acknowledged.add(seat);
        return m.abortion
          ? {
              protocolVersion: 1,
              kind: "match_aborted",
              matchId: m.spec.matchId,
              reason: m.abortion.reason,
            }
          : {
              protocolVersion: 1,
              kind: "match_over",
              matchId: m.spec.matchId,
              result: m.snapshot?.inspection.result ?? {},
            };
      }
      const turn = m.snapshot?.turns[principal];
      if (turn?.kind === "seat_finished") {
        if (m.acknowledgedFinished.has(seat)) continue;
        if (options.acknowledge !== false) m.acknowledgedFinished.add(seat);
        return structuredClone(turn);
      }
      if (turn?.kind === "turn" || turn?.kind === "waiting")
        return sampleNext(structuredClone(turn), now());
    }
    return { protocolVersion: 1, kind: "idle" };
  };
  return {
    async start(input) {
      sweep();
      if (held.has(input.matchId)) throw Error("duplicate match");
      if (
        [...held.values()].filter((m) => !settled(m)).length >= maxMatches ||
        held.size >= maxRetained
      )
        throw Object.assign(Error("match_capacity"), { kind: "capacity_error" });
      deps.registry.resolve(input.config);
      const spec = structuredClone(input);
      spec.startedAt ??= new Date(now()).toISOString();
      const m: HeldMatch = {
        spec,
        persisted: false,
        finalization: "pending",
        acknowledged: new Set(),
        acknowledgedFinished: new Set(),
        tail: Promise.resolve(),
      };
      held.set(spec.matchId, m);
      try {
        m.process = createProcessTransport(options);
      } catch {
        cancel(m, "game_error");
        await finish(m);
        return;
      }
      await serialize(m, () => dispatch(m, { kind: "start", spec }));
    },
    submit(principalId, matchId, tool, input, identity) {
      sweep();
      const m = held.get(matchId);
      if (!m) return Promise.resolve({ protocolVersion: 1, ok: false, reason: "unknown_match" });
      const reply = (response: Omit<SubmitEnvelope, "protocolVersion">): SubmitEnvelope => ({
        ...response,
        protocolVersion: 1,
      });
      if (!m.spec.assignments.some((s) => s.principalId === principalId))
        return Promise.resolve(reply({ ok: false, reason: "not_in_match" }));
      const body = JSON.stringify([tool, input, identity?.decisionId]);
      if (Buffer.byteLength(body) > 65536)
        return Promise.resolve(reply({ ok: false, reason: "request_too_large" }));
      const key = JSON.stringify([principalId, matchId, identity?.requestId]);
      if (identity) {
        if (!identity.requestId || !identity.decisionId)
          return Promise.resolve(reply({ ok: false, reason: "bad_request" }));
        const prior = receipts.get(key);
        if (prior)
          return prior.body === body
            ? prior.response
            : Promise.resolve(reply({ ok: false, reason: "request_conflict" }));
        if (receipts.size >= maxRequests)
          return Promise.resolve(reply({ ok: false, reason: "request_capacity" }));
      }
      const response = serialize(m, async () => {
        if (over(m)) {
          await finish(m).catch(() => undefined);
          return { ok: false, reason: m.abortion ? "match_aborted" : "match_over" };
        }
        return (
          (await dispatch(m, { kind: "submit", principalId, matchId, tool, input, identity })) ?? {
            ok: false,
            reason: "worker_command_failed",
          }
        );
      }).then(reply);
      if (identity) receipts.set(key, { body, response, expires: now() + retentionMs });
      return response;
    },
    poll,
    async next(principal) {
      const started = now();
      for (;;) {
        for (const m of held.values())
          if (m.spec.assignments.some((s) => s.principalId === principal))
            await serialize(m, () => dispatch(m, { kind: "reap" }));
        const result = poll(principal);
        if (result.kind !== "idle") return result;
        if (now() - started >= (deps.maxHoldMs ?? 25000)) return result;
        await (deps.sleep ?? Bun.sleep)(deps.pollIntervalMs ?? 250);
      }
    },
    async reap() {
      sweep();
      await Promise.all(
        [...held.values()].map((m) => serialize(m, () => dispatch(m, { kind: "reap" }))),
      );
    },
    abort: (id, reason) => {
      const m = held.get(id);
      if (!m) return Promise.resolve();
      return serialize(m, async () => {
        cancel(m, reason);
        await finish(m);
      });
    },
    acknowledge(principal, id) {
      const m = held.get(id);
      const seat = m?.spec.assignments.find((s) => s.principalId === principal)?.seat;
      if (m?.persisted && seat) m.acknowledged.add(seat);
    },
    list: () => [...held.values()].filter((m) => !over(m)).map(summarize),
    inspect: () => [...held.values()].map(summarize),
    view: (id) => {
      const m = held.get(id);
      return m && !m.abortion && (!over(m) || m.persisted)
        ? sampleView(structuredClone(m.snapshot?.view ?? null), now())
        : null;
    },
  };
}

export function createProcessVerifier(options: ProcessLimits & { maxConcurrent?: number }) {
  const maxConcurrent = positiveLimit(options.maxConcurrent, 2);
  let active = 0;
  return async (command: {
    config: MatchSpec["config"];
    seed: string;
    jsonl: string;
    publishedResult?: GameResult | null;
  }): Promise<{ ok: boolean; detail?: string; divergenceSeq?: number }> => {
    if (active >= maxConcurrent) return { ok: false, detail: "verification_capacity" };
    active++;
    let worker: ProcessTransport | undefined;
    try {
      worker = createProcessTransport(options);
      return await worker.request({ kind: "verify", ...command } satisfies WorkerCommand);
    } catch {
      return { ok: false, detail: "verification_worker_failed" };
    } finally {
      await worker?.close();
      active--;
    }
  };
}

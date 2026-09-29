import { type MatchConfig, type SeatId, mkSeatId } from "@benchboss/core";
import type { MatchSpec } from "./games";

export interface QueueEntry {
  agentId: string;
  principalId: string;
  gameId: string;
  enqueuedAt: number;
}

export interface LobbyOptions {
  /** Supported seat counts per game, as the manifest advertises them. */
  seatCountsForGame: (gameId: string) => readonly number[];
  /** Countdown from the moment a variable-size queue reaches its minimum. Default 30s. */
  lockWindowMs?: number;
}

export interface MatchmakerDeps {
  maxMatches?: number;
  reserve?: boolean;
  nextMatchId: (gameId: string) => string;
  nextSeed: (matchId: string) => string;
  buildConfig: (matchId: string, gameId: string, seats: SeatId[]) => MatchConfig;
}

export interface QueueSnapshot {
  gameId: string;
  queued: number;
  minSeats: number;
  maxSeats: number;
  oldestEnqueuedAt: number | null;
  /** When the queue locks into a match unless it fills first; null below the minimum or for static games. */
  locksAt: number | null;
}

export interface Lobby {
  hasAgent(agentId: string): boolean;
  removeAgent(agentId: string): void;
  size(): number;
  settle(matchId: string, admitted: boolean): void;
  enqueue(entry: { agentId: string; principalId: string; gameId: string }, nowMs: number): boolean;
  queued(gameId: string): number;
  locksAt(gameId: string): number | null;
  snapshot(): QueueSnapshot[];
  matchmake(deps: MatchmakerDeps, nowMs: number): MatchSpec[];
}

interface SeatPolicy {
  counts: number[];
  min: number;
  max: number;
  /** A game advertising exactly one seat count starts the moment that many agents queue. */
  isStatic: boolean;
}

// A queue holding at least the minimum is counting down from the arrival of the agent that
// completed the minimum; the countdown is derived from enqueue times, never stored, so leaving
// agents, drawn matches and returned reservations all recompute it from what remains.
export function createLobby(options: LobbyOptions): Lobby {
  const queues = new Map<string, QueueEntry[]>();
  const reserved = new Map<string, QueueEntry[]>();
  const lockWindowMs = options.lockWindowMs ?? 30_000;
  if (!Number.isFinite(lockWindowMs) || lockWindowMs < 0) throw Error("invalid lock window");

  const policyFor = (gameId: string): SeatPolicy => {
    const counts = [...new Set(options.seatCountsForGame(gameId))].sort((a, b) => a - b);
    if (!counts.length || counts.some((n) => !Number.isSafeInteger(n) || n < 1))
      throw Error("invalid seat counts");
    return {
      counts,
      min: counts[0] as number,
      max: counts[counts.length - 1] as number,
      isStatic: counts.length === 1,
    };
  };
  const locksAt = (queue: QueueEntry[], policy: SeatPolicy): number | null => {
    if (policy.isStatic || queue.length < policy.min) return null;
    return (queue[policy.min - 1] as QueueEntry).enqueuedAt + lockWindowMs;
  };
  const lockedSize = (queue: QueueEntry[], policy: SeatPolicy, nowMs: number): number | null => {
    if (queue.length < policy.min) return null;
    const deadline = locksAt(queue, policy);
    const due = policy.isStatic || queue.length >= policy.max || (deadline ?? 0) <= nowMs;
    if (!due) return null;
    return policy.counts.filter((n) => n <= queue.length).pop() ?? null;
  };

  return {
    hasAgent: (id) =>
      [...queues.values(), ...reserved.values()].some((q) => q.some((e) => e.agentId === id)),
    removeAgent(id) {
      for (const [game, queue] of queues)
        queues.set(
          game,
          queue.filter((e) => e.agentId !== id),
        );
    },
    size: () => [...queues.values(), ...reserved.values()].reduce((n, q) => n + q.length, 0),
    settle(id, admitted) {
      const entries = reserved.get(id);
      reserved.delete(id);
      if (admitted || !entries?.length) return;
      const game = entries[0]?.gameId;
      if (!game) return;
      const queue = queues.get(game) ?? [];
      queues.set(
        game,
        [...entries, ...queue].sort((a, b) => a.enqueuedAt - b.enqueuedAt),
      );
    },
    enqueue(entry, nowMs) {
      const queue = queues.get(entry.gameId) ?? [];
      if (queue.some((e) => e.agentId === entry.agentId)) return false;
      queue.push({ ...entry, enqueuedAt: nowMs });
      queues.set(entry.gameId, queue);
      return true;
    },
    queued: (gameId) => queues.get(gameId)?.length ?? 0,
    locksAt: (gameId) => locksAt(queues.get(gameId) ?? [], policyFor(gameId)),
    snapshot: () =>
      [...queues.entries()].map(([gameId, queue]) => {
        const policy = policyFor(gameId);
        return {
          gameId,
          queued: queue.length,
          minSeats: policy.min,
          maxSeats: policy.max,
          oldestEnqueuedAt: queue.length ? Math.min(...queue.map((e) => e.enqueuedAt)) : null,
          locksAt: locksAt(queue, policy),
        };
      }),
    matchmake(deps, nowMs) {
      const specs: MatchSpec[] = [];
      for (const [gameId, queue] of queues) {
        const policy = policyFor(gameId);
        for (;;) {
          if (specs.length >= (deps.maxMatches ?? Number.POSITIVE_INFINITY)) return specs;
          const need = lockedSize(queue, policy, nowMs);
          if (need === null) break;
          const drawn = queue.splice(0, need);
          const matchId = deps.nextMatchId(gameId);
          const seats = drawn.map((_, i) => mkSeatId(i));
          specs.push({
            matchId,
            gameId,
            seed: deps.nextSeed(matchId),
            config: deps.buildConfig(matchId, gameId, seats),
            assignments: drawn.map((e, i) => ({
              agentId: e.agentId,
              principalId: e.principalId,
              seat: seats[i] as SeatId,
            })),
          });
          if (deps.reserve) reserved.set(matchId, drawn);
        }
      }
      return specs;
    },
  };
}

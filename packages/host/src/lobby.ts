import { type MatchConfig, type SeatId, mkSeatId } from "@benchboss/core";
import type { MatchSpec } from "./games";

export interface QueueEntry {
  agentId: string;
  principalId: string;
  gameId: string;
  enqueuedAt: number;
}

export interface MatchmakerDeps {
  maxMatches?: number;
  reserve?: boolean;
  nextMatchId: (gameId: string) => string;
  nextSeed: (matchId: string) => string;
  seatsForGame: (gameId: string) => number;
  buildConfig: (matchId: string, gameId: string, seats: SeatId[]) => MatchConfig;
}

export interface QueueSnapshot {
  gameId: string;
  queued: number;
  oldestEnqueuedAt: number | null;
}

export interface Lobby {
  hasAgent(agentId: string): boolean;
  removeAgent(agentId: string): void;
  size(): number;
  settle(matchId: string, admitted: boolean): void;
  enqueue(entry: { agentId: string; principalId: string; gameId: string }, nowMs: number): boolean;
  queued(gameId: string): number;
  snapshot(): QueueSnapshot[];
  matchmake(deps: MatchmakerDeps): MatchSpec[];
}

export function createLobby(): Lobby {
  const queues = new Map<string, QueueEntry[]>();
  const reserved = new Map<string, QueueEntry[]>();

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
    enqueue(
      entry: { agentId: string; principalId: string; gameId: string },
      nowMs: number,
    ): boolean {
      const queue = queues.get(entry.gameId) ?? [];
      if (queue.some((e) => e.agentId === entry.agentId)) return false;
      queue.push({ ...entry, enqueuedAt: nowMs });
      queues.set(entry.gameId, queue);
      return true;
    },

    queued(gameId: string): number {
      return queues.get(gameId)?.length ?? 0;
    },

    snapshot(): QueueSnapshot[] {
      return [...queues.entries()].map(([gameId, queue]) => ({
        gameId,
        queued: queue.length,
        oldestEnqueuedAt: queue.length ? Math.min(...queue.map((e) => e.enqueuedAt)) : null,
      }));
    },

    matchmake(deps: MatchmakerDeps): MatchSpec[] {
      const specs: MatchSpec[] = [];
      for (const [gameId, queue] of queues) {
        const need = deps.seatsForGame(gameId);
        if (!Number.isSafeInteger(need) || need < 1) throw Error("invalid seat count");
        while (queue.length >= need) {
          if (specs.length >= (deps.maxMatches ?? Number.POSITIVE_INFINITY)) return specs;
          const drawn = queue.slice(0, need);
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
          queue.splice(0, need);
          if (deps.reserve) reserved.set(matchId, drawn);
        }
      }
      return specs;
    },
  };
}

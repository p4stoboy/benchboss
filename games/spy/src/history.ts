import { type LogEvent, type SeatId, parseJsonl } from "@benchboss/core";

export interface MatchRecord {
  matchId: string;
  seed: string;
  winner: "loyal" | "mole" | null;
  reason: string;
  score: Record<string, number>;
  toolCalls: Record<string, number>;
}

export type MatchHistory = readonly MatchRecord[];

export function emptyHistory(): MatchHistory {
  return [];
}

export function addRecord(history: MatchHistory, r: MatchRecord): MatchHistory {
  return [...history, r];
}

export function historyForSeat(history: MatchHistory, seat: SeatId): MatchRecord[] {
  return history.filter((r) => Object.prototype.hasOwnProperty.call(r.score, seat));
}

export function historyResource(
  history: MatchHistory,
  seat: SeatId,
  matchId: string,
): MatchRecord | null {
  const record = history.find((r) => r.matchId === matchId) ?? null;
  if (record === null) return null;
  return Object.prototype.hasOwnProperty.call(record.score, seat) ? record : null;
}

export function computeBonusAwards(records: MatchRecord[]): {
  giantKiller: string | null;
  lowestToolCall: string | null;
} {
  const totals: Record<string, number> = {};
  const callTotals: Record<string, number> = {};
  const gamesPlayed: Record<string, number> = {};

  for (const r of records) {
    for (const [seat, pts] of Object.entries(r.score)) {
      totals[seat] = (totals[seat] ?? 0) + pts;
      gamesPlayed[seat] = (gamesPlayed[seat] ?? 0) + 1;
    }
    for (const [seat, calls] of Object.entries(r.toolCalls)) {
      callTotals[seat] = (callTotals[seat] ?? 0) + calls;
    }
  }

  const topAgent =
    Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  // Giant Killer: most wins against the top-points agent in shared matches.
  // Tie-break: localeCompare ascending (same style as topAgent).
  const killCounts: Record<string, number> = {};
  for (const r of records) {
    if (topAgent === null || r.score[topAgent] !== 0) continue;
    for (const [seat, pts] of Object.entries(r.score)) {
      if (seat === topAgent || pts !== 1) continue;
      killCounts[seat] = (killCounts[seat] ?? 0) + 1;
    }
  }
  const giantKillerEntry =
    Object.entries(killCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? null;
  const giantKiller = giantKillerEntry !== null ? giantKillerEntry[0] : null;

  // Lowest-Tool-Call: smallest average tool calls per game.
  let lowestToolCall: string | null = null;
  let bestAvg = Number.POSITIVE_INFINITY;
  for (const seat of Object.keys(callTotals)) {
    const played = gamesPlayed[seat] ?? 1;
    const total = callTotals[seat] ?? 0;
    const avg = total / Math.max(1, played);
    if (avg < bestAvg) {
      bestAvg = avg;
      lowestToolCall = seat;
    }
  }

  return { giantKiller, lowestToolCall };
}

export interface ReplayFrame {
  seq: number;
  phase: string;
  seat: string | null;
  kind: string;
  summary: string;
}

function summarize(e: LogEvent): string {
  switch (e.kind) {
    case "rng.commit":
      return `seed committed (${String((e.payload as { hash?: string }).hash ?? "")})`;
    case "rng.reveal":
      return "seed revealed";
    case "action.submit":
      return `${e.seat ?? "system"} submitted in ${e.phase}`;
    case "action.default":
      return `${e.seat ?? "system"} safe-defaulted in ${e.phase}`;
    case "phase.resolve": {
      const p = e.payload as { sabotageCount?: number; result?: string };
      const count = p.sabotageCount;
      const resultStr = p.result !== undefined ? ` result=${p.result}` : "";
      const sabotageStr = count !== undefined ? ` sabotages=${count}` : "";
      return `${e.phase} resolved${resultStr}${sabotageStr}`;
    }
    case "match.terminal":
      return `match over: ${String((e.payload as { reason?: string }).reason ?? "")}`;
    default:
      return e.kind;
  }
}

export function projectReplay(jsonl: string): {
  frames: ReplayFrame[];
  outcome: { winner: string | null; reason: string };
} {
  const log = parseJsonl(jsonl);
  const frames: ReplayFrame[] = log
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: e.seq,
      phase: e.phase,
      seat: e.seat,
      kind: e.kind,
      summary: summarize(e),
    }));
  const terminal = log.find((e) => e.kind === "match.terminal");
  const payload = (terminal?.payload ?? {}) as {
    winner?: string;
    reason?: string;
  };
  return {
    frames,
    outcome: { winner: payload.winner ?? null, reason: payload.reason ?? "" },
  };
}

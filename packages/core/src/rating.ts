import { rate, rating } from "openskill";
import type { SeatId } from "./types";

type OsRating = ReturnType<typeof rating>;

interface Row {
  agent: string;
  points: number;
  wins: number;
  games: number;
  os: OsRating;
}

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`missing key: ${String(key)}`);
  return v;
}

export interface RatingTableRow {
  agent: string;
  points: number;
  winRate: number;
  openskillMu?: number;
  openskillSigma?: number;
}

export interface RatingState {
  readonly seatToAgent: Record<SeatId, string>;
  readonly useOpenskill: boolean;
  readonly rows: ReadonlyMap<string, Row>;
}

export function initRating(
  seatToAgent: Record<SeatId, string>,
  opts?: { openskill?: boolean },
): RatingState {
  const rows = new Map<string, Row>();
  for (const agent of Object.values(seatToAgent)) {
    if (!rows.has(agent)) {
      rows.set(agent, { agent, points: 0, wins: 0, games: 0, os: rating() });
    }
  }
  return { seatToAgent, useOpenskill: opts?.openskill ?? false, rows };
}

function agentOf(seatToAgent: Record<SeatId, string>, seat: SeatId): string {
  const agent = seatToAgent[seat];
  if (agent === undefined) throw new Error(`unknown seat: ${seat}`);
  return agent;
}

export function recordResult(state: RatingState, result: Record<SeatId, number>): RatingState {
  const entries = Object.entries(result) as Array<[SeatId, number]>;
  const max = Math.max(...entries.map(([, v]) => v));
  const rows = new Map<string, Row>();
  for (const [agent, row] of state.rows) rows.set(agent, { ...row });
  for (const [seat, value] of entries) {
    const row = mustGet(rows, agentOf(state.seatToAgent, seat));
    row.points += value;
    row.games += 1;
    if (value === max) row.wins += 1;
  }
  if (state.useOpenskill) {
    const ordered = [...entries].sort((a, b) => b[1] - a[1]);
    const teams = ordered.map(([seat]) => [mustGet(rows, agentOf(state.seatToAgent, seat)).os]);
    const ranks = ordered.map((_, i) => i + 1);
    const updated = rate(teams, { rank: ranks });
    ordered.forEach(([seat], i) => {
      const row = mustGet(rows, agentOf(state.seatToAgent, seat));
      const newRating = updated[i]?.[0];
      if (newRating !== undefined) row.os = newRating;
    });
  }
  return { ...state, rows };
}

export function ratingTable(state: RatingState): RatingTableRow[] {
  const rows = [...state.rows.values()].map((r) => ({
    agent: r.agent,
    points: r.points,
    winRate: r.games === 0 ? 0 : r.wins / r.games,
    ...(state.useOpenskill ? { openskillMu: r.os.mu, openskillSigma: r.os.sigma } : {}),
  }));
  rows.sort(
    (a, b) => b.points - a.points || b.winRate - a.winRate || a.agent.localeCompare(b.agent),
  );
  return rows;
}

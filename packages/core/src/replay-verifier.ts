import type { GameResult } from "@benchboss/protocol";
import { sha256Commit } from "./rng";
import type { GameModule, LogEvent, MatchConfig, SeatId } from "./types";

// Canonicalize a score map for byte-exact comparison independent of key
// insertion order: sort entries by key before serializing. Scores are
// Record<seat, number>; non-object inputs serialize verbatim.
function canonicalScore(score: unknown): string {
  if (score === null || typeof score !== "object") return JSON.stringify(score);
  const sorted = Object.fromEntries(
    Object.entries(score as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
  return JSON.stringify(sorted);
}

function canonicalConfig(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalConfig(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function verifyReplay<State>(args: {
  // biome-ignore lint/suspicious/noExplicitAny: verbatim contract — GameModule is covariant here
  game: GameModule<State, any, any, any>;
  projectResult?: (state: State) => GameResult | null;
  publishedResult?: GameResult | null;
  config: MatchConfig;
  seed: string;
  log: readonly LogEvent[];
}): { ok: boolean; divergenceSeq?: number; detail?: string } {
  const { game, config, seed, log } = args;
  let activeSeq = 0;
  try {
    for (const [index, event] of log.entries()) {
      activeSeq = index;
      if (event.seq !== index || event.matchId !== config.matchId) {
        return { ok: false, divergenceSeq: index, detail: "invalid sequence or match identity" };
      }
      if (event.kind === "rng.commit" && event.payload.hash !== sha256Commit(seed)) {
        return { ok: false, divergenceSeq: index, detail: "seed commitment mismatch" };
      }
      if (event.kind === "rng.reveal" && event.payload.seed !== seed) {
        return { ok: false, divergenceSeq: index, detail: "seed reveal mismatch" };
      }
    }
    if (
      log.filter((event) => event.kind === "match.terminal").length !== 1 ||
      log.at(-1)?.kind !== "match.terminal"
    ) {
      return {
        ok: false,
        divergenceSeq: log.length,
        detail: "expected exactly one terminal event at the end",
      };
    }
    activeSeq = 0;
    let state = game.newMatch(config, seed);

    for (const event of log) {
      activeSeq = event.seq;
      if (event.kind === "action.submit" || event.kind === "action.default") {
        if (event.seat === null || !config.seats.includes(event.seat)) {
          return { ok: false, divergenceSeq: event.seq, detail: `${event.kind} with null seat` };
        }
        const action = (event.payload as { action: unknown }).action;
        const result = game.submit(
          state,
          event.seat as SeatId,
          action,
          typeof event.payload.tool === "string" ? event.payload.tool : undefined,
        );
        if (!result.accepted) {
          return { ok: false, divergenceSeq: event.seq, detail: `rejected: ${result.reason}` };
        }
        state = result.state;
      } else if (event.kind === "phase.resolve") {
        state = game.step(state);
      } else if (event.kind === "match.terminal") {
        const recordedConfig = event.payload.config as MatchConfig | undefined;
        if (
          "config" in event.payload &&
          canonicalConfig(recordedConfig) !== canonicalConfig(config)
        ) {
          return { ok: false, divergenceSeq: event.seq, detail: "resolved configuration mismatch" };
        }
        if (!game.isTerminal(state)) {
          return {
            ok: false,
            divergenceSeq: event.seq,
            detail: "log says terminal but state is not",
          };
        }
        // Score comparison is key-order-independent: both sides are canonicalized
        // by sorting entries by key, so a game whose score() builds its map in a
        // different insertion order does not falsely diverge.
        const expected = canonicalScore((event.payload as { score: unknown }).score);
        const actual = canonicalScore(game.score(state));
        if (expected !== actual) {
          return {
            ok: false,
            divergenceSeq: event.seq,
            detail: `score mismatch: ${actual} != ${expected}`,
          };
        }
        if (args.projectResult && (config.identity || "result" in event.payload)) {
          const outcome = canonicalConfig(args.projectResult(state));
          if (
            outcome !== canonicalConfig(event.payload.result) ||
            (args.publishedResult !== undefined &&
              outcome !== canonicalConfig(args.publishedResult))
          )
            return { ok: false, divergenceSeq: event.seq, detail: "terminal outcome mismatch" };
        }
      }
      // sense.serve events are intentionally ignored.
      // Sensing effects are confined to privateState and never influence
      // score(state)/isTerminal(state), so terminal-equality still holds
      // without replaying them. Any future change that lets a sensing result
      // affect scored/terminal state MUST also make verify() replay
      // sense.serve events, or replay will silently diverge.
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      divergenceSeq: activeSeq,
      detail: "malformed replay data or game execution failure",
    };
  }
}

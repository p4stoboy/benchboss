import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import {
  type MatchHistory,
  type MatchRecord,
  addRecord,
  computeBonusAwards,
  emptyHistory,
  historyForSeat,
  historyResource,
} from "../src/history";

const s0 = mkSeatId(0);
function rec(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    matchId: "m1",
    seed: "s",
    winner: "loyal",
    reason: "three-successful-ops",
    score: { "seat:0": 1, "seat:1": 0 },
    toolCalls: { "seat:0": 12, "seat:1": 30 },
    ...over,
  };
}

describe("M5 history and bonuses", () => {
  test("stores_and_retrieves_a_match_record_by_id", () => {
    let history = emptyHistory();
    history = addRecord(
      history,
      rec({
        matchId: "abc",
        score: { "seat:0": 1, "seat:1": 0 },
        toolCalls: { "seat:0": 5, "seat:1": 5 },
      }),
    );
    const found = historyResource(history, s0, "abc");
    expect(found).toBeDefined();
    expect(found?.matchId).toBe("abc");
    expect(historyResource(history, s0, "missing")).toBeNull();
  });

  test("for_seat_returns_only_matches_that_seat_played", () => {
    let history = emptyHistory();
    history = addRecord(
      history,
      rec({
        matchId: "m1",
        score: { "seat:0": 1 },
        toolCalls: { "seat:0": 5 },
      }),
    );
    history = addRecord(
      history,
      rec({
        matchId: "m2",
        score: { "seat:1": 1 },
        toolCalls: { "seat:1": 5 },
      }),
    );
    expect(historyForSeat(history, s0).map((r) => r.matchId)).toEqual(["m1"]);
  });

  test("lowest_tool_call_award_goes_to_the_thriftiest_seat", () => {
    const records = [rec()];
    const awards = computeBonusAwards(records);
    expect(awards.lowestToolCall).toBe("seat:0"); // 12 < 30
  });

  test("giant_killer_award_goes_to_agent_that_beats_top_scorer_most", () => {
    // seat:0 is top scorer (3 pts total vs seat:1's 2), seat:1 beats seat:0 in m2 and m3
    const records = [
      rec({ matchId: "m1", score: { "seat:0": 1, "seat:1": 0 } }),
      rec({ matchId: "m2", score: { "seat:0": 1, "seat:1": 0 } }),
      rec({ matchId: "m3", score: { "seat:0": 0, "seat:1": 1 } }),
      rec({ matchId: "m4", score: { "seat:0": 0, "seat:1": 1 } }),
    ];
    // seat:0 total=2, seat:1 total=2 — tie broken by localeCompare: seat:0 < seat:1 → seat:0 is top
    // seat:1 beats seat:0 in m3 and m4 (2 kills) → giant killer
    const awards = computeBonusAwards(records);
    expect(awards.giantKiller).toBe("seat:1");
  });

  test("privacy_for_seat_does_not_expose_other_seat_history", () => {
    let history = emptyHistory();
    const s1 = mkSeatId(1);
    history = addRecord(
      history,
      rec({ matchId: "private-m", score: { "seat:1": 1 }, toolCalls: { "seat:1": 10 } }),
    );
    const s0Results = historyForSeat(history, s0);
    expect(s0Results).toHaveLength(0);
    expect(s0Results.find((r) => r.matchId === "private-m")).toBeUndefined();
    // s1 CAN see their own match
    const s1Results = historyForSeat(history, s1);
    expect(s1Results).toHaveLength(1);
    expect(s1Results.map((r) => r.matchId)).toContain("private-m");
  });

  test("all_returns_all_recorded_matches", () => {
    let history = emptyHistory();
    history = addRecord(history, rec({ matchId: "x1" }));
    history = addRecord(history, rec({ matchId: "x2" }));
    expect(history).toHaveLength(2);
    expect(history.map((r) => r.matchId)).toEqual(["x1", "x2"]);
  });

  test("empty_records_returns_null_awards", () => {
    const awards = computeBonusAwards([]);
    expect(awards.giantKiller).toBeNull();
    expect(awards.lowestToolCall).toBeNull();
  });

  test("resource_returns_null_for_non_participant_seat", () => {
    let history = emptyHistory();
    const s1 = mkSeatId(1);
    history = addRecord(
      history,
      rec({
        matchId: "mB",
        score: { "seat:1": 1, "seat:2": 0 },
        toolCalls: { "seat:1": 5, "seat:2": 5 },
      }),
    );
    // s0 did NOT play mB — must get null
    expect(historyResource(history, s0, "mB")).toBeNull();
    // s1 DID play mB — must get the record
    const found = historyResource(history, s1, "mB");
    expect(found).toBeDefined();
    expect(found?.matchId).toBe("mB");
  });

  test("giant_killer_tie_broken_by_locale_compare_ascending", () => {
    // seat:0 is top scorer (2 pts); seat:1 and seat:2 each beat seat:0 exactly once — tie
    // localeCompare: "seat:1" < "seat:2", so seat:1 must win
    const records = [
      rec({
        matchId: "t1",
        score: { "seat:0": 1, "seat:1": 0, "seat:2": 0 },
        toolCalls: { "seat:0": 5, "seat:1": 5, "seat:2": 5 },
      }),
      rec({
        matchId: "t2",
        score: { "seat:0": 0, "seat:1": 1, "seat:2": 0 },
        toolCalls: { "seat:0": 5, "seat:1": 5, "seat:2": 5 },
      }),
      rec({
        matchId: "t3",
        score: { "seat:0": 0, "seat:1": 0, "seat:2": 1 },
        toolCalls: { "seat:0": 5, "seat:1": 5, "seat:2": 5 },
      }),
    ];
    // seat:0 total=1, seat:1 total=1, seat:2 total=1 — tie broken by localeCompare: seat:0 wins top
    // seat:1 beats seat:0 in t2 (1 kill); seat:2 beats seat:0 in t3 (1 kill) — tie on kills
    // localeCompare tie-break: "seat:1" < "seat:2" → seat:1 is giant killer
    const awards = computeBonusAwards(records);
    expect(awards.giantKiller).toBe("seat:1");
  });
});

import { projectReplay } from "../src/history";
import { runSpyMatch } from "./harness";

describe("M5 spectator replay viewer", () => {
  test("projects_a_finished_match_into_ordered_frames", () => {
    const { jsonl } = runSpyMatch({ seed: "viewer-seed" });
    const { frames, outcome } = projectReplay(jsonl);
    expect(frames.length).toBeGreaterThan(0);
    // frames are in seq order
    for (let i = 1; i < frames.length; i++) {
      const curr = frames[i];
      const prev = frames[i - 1];
      expect(curr).toBeDefined();
      expect(prev).toBeDefined();
      if (curr === undefined || prev === undefined) continue;
      expect(curr.seq).toBeGreaterThan(prev.seq);
    }
    expect(["loyal", "mole", null]).toContain(outcome.winner);
  });

  test("every_frame_has_a_summary_string", () => {
    const { jsonl } = runSpyMatch({ seed: "viewer-seed" });
    const { frames } = projectReplay(jsonl);
    for (const f of frames) expect(typeof f.summary).toBe("string");
  });

  test("projection_is_pure_same_log_same_frames", () => {
    const { jsonl } = runSpyMatch({ seed: "pure-seed" });
    const r1 = projectReplay(jsonl);
    const r2 = projectReplay(jsonl);
    expect(r1.frames.length).toBe(r2.frames.length);
    expect(r1.outcome.winner).toBe(r2.outcome.winner);
    expect(r1.outcome.reason).toBe(r2.outcome.reason);
  });

  test("spectator_timeline_does_not_expose_mid_match_role_assignments", () => {
    const { jsonl } = runSpyMatch({ seed: "leak-seed" });
    const { frames } = projectReplay(jsonl);
    // The terminal event (match.terminal) may appear — that is post-game reveal.
    // All frames produced BEFORE the terminal frame must not contain role info
    // (i.e. no frame summary should mention "mole" or "loyal" unless it's the terminal frame).
    const terminalIdx = frames.findIndex((f) => f.kind === "match.terminal");
    const preTerminal = terminalIdx >= 0 ? frames.slice(0, terminalIdx) : frames;
    for (const f of preTerminal) {
      // summaries before terminal must not embed raw role names
      expect(f.summary).not.toMatch(/\b(mole|loyal)\b/);
    }
  });

  test("sabotage_count_not_identities_in_op_outcome_frames", () => {
    // op outcome frames (phase.resolve) should carry a numeric count, not seat names
    const { jsonl } = runSpyMatch({ seed: "sabotage-seed" });
    const { frames } = projectReplay(jsonl);
    const resolveFrames = frames.filter((f) => f.kind === "phase.resolve");
    // There should be at least one phase.resolve frame
    expect(resolveFrames.length).toBeGreaterThan(0);
    for (const f of resolveFrames) {
      // summary must not embed seat IDs of saboteurs (seat:N format)
      // it may contain numeric counts only
      expect(f.summary).not.toMatch(/sabotaged by seat:\d+/);
    }
  });

  test("real_match_surfaces_a_concrete_winner_and_reason_through_the_server", () => {
    // I1: the viewer must read a REAL winner/reason from a real runSpyMatch log —
    // proving the producer (MatchServer terminalSummary opt) and consumer
    // (projectReplay) shapes now agree. Previously this was always {winner:null}.
    const { jsonl } = runSpyMatch({ seed: "i1-real-seed" });
    const { outcome } = projectReplay(jsonl);
    expect(outcome.winner).not.toBeNull();
    expect(["loyal", "mole"]).toContain(outcome.winner ?? "");
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  test("operation_resolve_frames_carry_a_sabotage_count_never_a_saboteur_identity", () => {
    // I1: resolveSummary surfaces only the PUBLIC op result (count + success/fail).
    // The raw phase.resolve operation payloads must carry a numeric sabotageCount
    // and must never embed a seat id (saboteur identity).
    const { jsonl } = runSpyMatch({ seed: "i1-sabotage-seed" });
    const events = jsonl
      .trim()
      .split("\n")
      .map(
        (l) => JSON.parse(l) as { kind: string; phase: string; payload: Record<string, unknown> },
      );
    const opResolves = events.filter((e) => e.kind === "phase.resolve" && e.phase === "operation");
    expect(opResolves.length).toBeGreaterThan(0);
    for (const e of opResolves) {
      expect(typeof e.payload.sabotageCount).toBe("number");
      const result = e.payload.result;
      expect(typeof result).toBe("string");
      expect(["success", "fail"]).toContain(typeof result === "string" ? result : "");
      // No saboteur identity anywhere in the payload.
      expect(JSON.stringify(e.payload)).not.toMatch(/seat:\d+/);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { runSpyMatch, verifySpyReplay } from "./harness";

describe("spy full-match replay", () => {
  test("a_self_played_match_terminates_with_a_winner", () => {
    const { jsonl, score } = runSpyMatch({ seed: "match-seed-1" });
    expect(jsonl.length).toBeGreaterThan(0);
    const points = Object.values(score);
    expect(points.some((p) => p === 1)).toBe(true); // someone won
  });

  test("the_logged_match_replays_byte_identical", () => {
    const { jsonl } = runSpyMatch({ seed: "match-seed-1" });
    const verify = verifySpyReplay({ jsonl, seed: "match-seed-1" });
    expect(verify.ok).toBe(true);
    expect(verify.divergenceSeq).toBeUndefined();
  });

  test("replay_detects_a_tampered_log", () => {
    const { jsonl } = runSpyMatch({ seed: "match-seed-1" });
    const lines = jsonl.trim().split("\n");
    // Corrupt a vote-phase action.submit: replacing the vote action with a
    // payload that has no "vote" key causes game.submit to return !accepted in
    // the vote phase, so the verifier returns ok:false.
    const idx = lines.findIndex((l) => {
      const parsed = JSON.parse(l) as { kind: string; phase: string };
      return parsed.kind === "action.submit" && parsed.phase === "vote";
    });
    const ev = JSON.parse(lines[idx] as string) as {
      payload: Record<string, unknown>;
    };
    // Replace payload.action with an object that has no "vote" key — the game
    // rejects it in the vote phase and the verifier detects the divergence.
    ev.payload = { action: { tampered: true } };
    lines[idx] = JSON.stringify(ev);
    const verify = verifySpyReplay({
      jsonl: `${lines.join("\n")}\n`,
      seed: "match-seed-1",
    });
    expect(verify.ok).toBe(false);
    expect(verify.divergenceSeq).toBeDefined();
  });

  test("replay_ignores_sense_serve_events_so_sensing_is_replay_irrelevant", () => {
    // Sensing invariant (Core ReplayVerifier): `sense.serve` events are NOT
    // re-applied during replay — sensing mutates only privateState
    // (state.intelResults), never scored/terminal state. Inject a synthetic
    // sense.serve mid-log and confirm byte-identical replay still verifies.
    const { jsonl } = runSpyMatch({ seed: "match-seed-1" });
    const lines = jsonl.trim().split("\n");
    const idx = lines.findIndex((l) => l.includes('"action.submit"'));
    const sample = JSON.parse(lines[idx] as string) as {
      seq: number;
      matchId: string;
      phase: string;
      seat: string;
    };
    const senseEvent = JSON.stringify({
      seq: sample.seq, // sequence positions are rebuilt below after insertion
      matchId: sample.matchId,
      phase: sample.phase,
      seat: sample.seat,
      kind: "sense.serve",
      payload: { tool: "intel.scan_alignment", cost: 1 },
    });
    lines.splice(idx, 0, senseEvent);
    for (let seq = 0; seq < lines.length; seq++) {
      lines[seq] = JSON.stringify({ ...JSON.parse(lines[seq] as string), seq });
    }
    const verify = verifySpyReplay({
      jsonl: `${lines.join("\n")}\n`,
      seed: "match-seed-1",
    });
    expect(verify.ok).toBe(true);
    expect(verify.divergenceSeq).toBeUndefined();
  });

  test("intel_and_comms_phases_recur_across_multiple_op_cycles", () => {
    // After each operation the loop re-enters debrief -> intel -> comms, so a
    // full match (>= 3 ops) must show the discussion phases more than once.
    const { jsonl } = runSpyMatch({ seed: "recur-seed" });
    const phases = jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; phase: string });
    const resolves = phases.filter((e) => e.kind === "phase.resolve");
    const intelResolves = resolves.filter((e) => e.phase === "intel").length;
    const commsResolves = resolves.filter((e) => e.phase === "comms").length;
    expect(intelResolves).toBeGreaterThan(1);
    expect(commsResolves).toBeGreaterThan(1);
  });
});

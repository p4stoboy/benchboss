import { describe, expect, test } from "bun:test";
import {
  type Command,
  type MatchHandle,
  type MatchSession,
  newSession,
  observe,
  sessionState,
  step,
} from "@benchboss/referee";
import { makeSpyGame } from "../src/game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import { spySenseResolvers } from "../src/sensing";
import type { SpyState } from "../src/types";
import { runSpyMatch, verifySpyReplay } from "./harness";
import { baseConfig } from "./helpers";

function harness<State>(session: MatchSession<State>): MatchHandle<State> {
  let s = session;
  return {
    get: () => s,
    advance: (cmd: Command) => {
      const r = step(s, cmd);
      s = r.session;
      return r.output;
    },
  };
}

describe("M2 MVP gate", () => {
  test("typed_speech_acts_pillar_a_match_plays_and_replays", () => {
    const { jsonl, score } = runSpyMatch({ seed: "gate-seed" });
    expect(verifySpyReplay({ jsonl, seed: "gate-seed" }).ok).toBe(true);
    expect(Object.values(score).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  test("budgeted_sensing_pillar_b_intel_tools_exist_and_belief_does_not", () => {
    const tools = Object.values(SPY_PHASE_TOOLS).flat();
    expect(tools).toContain("intel.scan_alignment");
    expect(tools).toContain("intel.audit_statement");
    expect(tools).not.toContain("belief.sample_worlds");
  });

  test("budgeted_sensing_pillar_b_intel_spends_points_through_the_server", () => {
    // Pillar B validated END-TO-END: an intel call through the server boundary
    // spends research and exhaustion is refused (not just name checks).
    const server = harness(
      newSession<SpyState>({
        game: makeSpyGame(),
        config: baseConfig(),
        seed: "gate-intel",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
        senseResolvers: spySenseResolvers("gate-intel"),
      }),
    );
    const seats = sessionState(server.get()).seats;
    for (const s of seats)
      server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
    expect(currentPhase(sessionState(server.get()))).toBe("intel");
    const s0 = seats[0];
    if (s0 === undefined) throw new Error("seats[0] undefined");
    const s3 = seats[3];
    if (s3 === undefined) throw new Error("seats[3] undefined");
    const token = s0;
    const points = () =>
      (observe(server.get(), token) as { resources: Record<string, number> }).resources.research;
    const before = points();
    if (before === undefined) throw new Error("research budget undefined");
    expect(
      server.advance({
        kind: "callTool",
        seat: token,
        tool: "intel.scan_alignment",
        input: { target: s3 },
      }).ok,
    ).toBe(true);
    expect(points()).toBe(before - 1);
  });

  test("game_id_is_safehouse_protocol", () => {
    expect(makeSpyGame().id).toBe("safehouse-protocol");
  });
});

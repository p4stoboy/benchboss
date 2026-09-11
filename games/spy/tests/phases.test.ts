import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { makeSpyGame } from "../src/game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import {
  missionActionSchema,
  proposeTeamSchema,
  submitPhaseEndSchema,
  voteSchema,
} from "../src/schemas";
import { baseConfig } from "./helpers";

const game = makeSpyGame();

describe("spy phases", () => {
  test("phase_tools_map_is_keyed_by_phase", () => {
    expect(SPY_PHASE_TOOLS.proposal).toEqual(["match.propose_team"]);
    expect(SPY_PHASE_TOOLS.operation).toEqual(["match.mission_action"]);
  });

  test("current_phase_returns_state_phase", () => {
    const st = game.newMatch(baseConfig(), "s");
    expect(currentPhase(st)).toBe("briefing");
  });

  test("vote_phase_ready_only_when_all_seats_voted", () => {
    let st = game.newMatch(baseConfig(), "s");
    st = { ...st, phase: "vote", votes: {} };
    expect(isReady(st)).toBe(false);
    const votes = Object.fromEntries(st.seats.map((s) => [s, "approve" as const]));
    expect(isReady({ ...st, votes })).toBe(true);
  });

  test("safe_default_in_operation_is_support_not_sabotage", () => {
    let st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    st = {
      ...st,
      phase: "operation",
      proposal: {
        proposalId: "p",
        leader: seat0 as NonNullable<typeof seat0>,
        team: [seat0 as NonNullable<typeof seat0>],
        opIndex: 0,
      },
    };
    expect(spySafeDefault(st, st.seats[0] as NonNullable<(typeof st.seats)[0]>)).toEqual({
      sabotage: false,
    });
  });

  test("safe_default_in_vote_is_reject", () => {
    let st = game.newMatch(baseConfig(), "s");
    const seat1 = st.seats[1];
    expect(seat1).toBeDefined();
    st = { ...st, phase: "vote" };
    expect(spySafeDefault(st, seat1 as NonNullable<typeof seat1>)).toEqual({ vote: "reject" });
  });

  test("briefing_not_ready_when_no_phase_ended", () => {
    const st = game.newMatch(baseConfig(), "s");
    expect(isReady(st)).toBe(false);
  });

  test("briefing_ready_when_all_seats_phase_ended", () => {
    const st = game.newMatch(baseConfig(), "s");
    const phaseEnded = Object.fromEntries(st.seats.map((s) => [s, true]));
    expect(isReady({ ...st, phaseEnded })).toBe(true);
  });

  test("proposal_not_ready_without_proposal", () => {
    const st = game.newMatch(baseConfig(), "s");
    expect(isReady({ ...st, phase: "proposal", proposal: null })).toBe(false);
  });

  test("proposal_ready_with_proposal", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const proposal = {
      proposalId: "p",
      leader: seat0 as NonNullable<typeof seat0>,
      team: [seat0 as NonNullable<typeof seat0>],
      opIndex: 0,
    };
    expect(isReady({ ...st, phase: "proposal", proposal })).toBe(true);
  });

  test("unknown_phase_is_never_ready", () => {
    const st = game.newMatch(baseConfig(), "s");
    // Cast to force the default branch
    expect(
      isReady({ ...st, phase: "assassinate" as unknown as import("../src/types").SpyPhase }),
    ).toBe(false);
  });

  test("safe_default_in_briefing_is_empty_object", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    expect(spySafeDefault(st, seat0 as NonNullable<typeof seat0>)).toEqual({});
  });

  test("safe_default_in_proposal_returns_team_array", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const result = spySafeDefault(
      { ...st, phase: "proposal" },
      seat0 as NonNullable<typeof seat0>,
    ) as { team: string[] };
    expect(Array.isArray(result.team)).toBe(true);
    // op 0 with 5 seats needs 2 members
    expect(result.team.length).toBe(2);
  });

  // Fix 1: safe defaults must pass their phase schemas

  test("safe_default_proposal_passes_proposeTeamSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const result = spySafeDefault({ ...st, phase: "proposal" }, seat0 as NonNullable<typeof seat0>);
    expect(() => proposeTeamSchema.parse(result)).not.toThrow();
    const parsed = proposeTeamSchema.parse(result);
    // op 0 with 5 seats needs 2 members
    expect(parsed.team.length).toBe(2);
  });

  test("safe_default_vote_passes_voteSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const stVote = { ...st, phase: "vote" as const };
    const result = spySafeDefault(stVote, seat0 as NonNullable<typeof seat0>);
    expect(() => voteSchema.parse(result)).not.toThrow();
  });

  test("safe_default_operation_passes_missionActionSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const stOp = {
      ...st,
      phase: "operation" as const,
      proposal: {
        proposalId: "p",
        leader: seat0 as NonNullable<typeof seat0>,
        team: [seat0 as NonNullable<typeof seat0>],
        opIndex: 0,
      },
    };
    const result = spySafeDefault(stOp, seat0 as NonNullable<typeof seat0>);
    expect(() => missionActionSchema.parse(result)).not.toThrow();
  });

  test("safe_default_briefing_passes_submitPhaseEndSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const result = spySafeDefault(st, seat0 as NonNullable<typeof seat0>);
    expect(() => submitPhaseEndSchema.parse(result)).not.toThrow();
  });

  test("safe_default_intel_passes_submitPhaseEndSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const stIntel = { ...st, phase: "intel" as const };
    const result = spySafeDefault(stIntel, seat0 as NonNullable<typeof seat0>);
    expect(() => submitPhaseEndSchema.parse(result)).not.toThrow();
  });

  test("safe_default_comms_passes_submitPhaseEndSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const stComms = { ...st, phase: "comms" as const };
    const result = spySafeDefault(stComms, seat0 as NonNullable<typeof seat0>);
    expect(() => submitPhaseEndSchema.parse(result)).not.toThrow();
  });

  test("safe_default_debrief_passes_submitPhaseEndSchema", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    const stDebrief = { ...st, phase: "debrief" as const };
    const result = spySafeDefault(stDebrief, seat0 as NonNullable<typeof seat0>);
    expect(() => submitPhaseEndSchema.parse(result)).not.toThrow();
  });

  // Fix 2: isReady for operation phase

  test("operation_not_ready_when_team_has_no_mission_actions", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    const seat1 = st.seats[1];
    expect(seat0).toBeDefined();
    expect(seat1).toBeDefined();
    const stOp = {
      ...st,
      phase: "operation" as const,
      proposal: {
        proposalId: "p",
        leader: seat0 as NonNullable<typeof seat0>,
        team: [seat0 as NonNullable<typeof seat0>, seat1 as NonNullable<typeof seat1>],
        opIndex: 0,
      },
      missionActions: [],
    };
    expect(isReady(stOp)).toBe(false);
  });

  test("operation_ready_when_all_team_members_submitted_mission_action", () => {
    const st = game.newMatch(baseConfig(), "s");
    const seat0 = st.seats[0];
    const seat1 = st.seats[1];
    expect(seat0).toBeDefined();
    expect(seat1).toBeDefined();
    const s0 = seat0 as NonNullable<typeof seat0>;
    const s1 = seat1 as NonNullable<typeof seat1>;
    const stOp = {
      ...st,
      phase: "operation" as const,
      proposal: {
        proposalId: "p",
        leader: s0,
        team: [s0, s1],
        opIndex: 0,
      },
      missionActions: [
        { seat: s0, sabotage: false },
        { seat: s1, sabotage: false },
      ],
    };
    expect(isReady(stOp)).toBe(true);
  });

  // Fix 3: pin full SPY_PHASE_TOOLS contract

  test("phase_tools_map_briefing", () => {
    expect(SPY_PHASE_TOOLS.briefing).toEqual(["match.submit_phase_end"]);
  });

  test("phase_tools_map_intel", () => {
    expect(SPY_PHASE_TOOLS.intel).toEqual([
      "intel.scan_alignment",
      "intel.audit_statement",
      "intel.trace_operation",
      "intel.plant_misinfo",
      "intel.counterintel",
      "intel.protect_source",
      "match.submit_phase_end",
    ]);
  });

  test("phase_tools_map_comms", () => {
    expect(SPY_PHASE_TOOLS.comms).toEqual(["comms.send", "match.submit_phase_end"]);
  });

  test("phase_tools_map_vote", () => {
    expect(SPY_PHASE_TOOLS.vote).toEqual(["match.vote"]);
  });

  test("phase_tools_map_debrief", () => {
    expect(SPY_PHASE_TOOLS.debrief).toEqual(["match.submit_phase_end"]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { makeSpyGame } from "../src/game";
import type { SpyPhase } from "../src/types";
import { baseConfig } from "./helpers";

const game = makeSpyGame();
const seat0 = mkSeatId(0);
const seat1 = mkSeatId(1);
const tools = (state: ReturnType<typeof game.newMatch>, seat = seat0) =>
  game.legalActions(state, seat).map((a) => a.tool);

describe("spy legal actions end with the seat's decision", () => {
  test("a seat that has voted has no legal action while others still vote", () => {
    const st = { ...game.newMatch(baseConfig(), "s"), phase: "vote" as SpyPhase };
    expect(tools(st)).toEqual(["match.vote"]);
    const voted = game.submit(st, seat0, { vote: "approve" }).state;
    expect(tools(voted)).toEqual([]);
    expect(tools(voted, seat1)).toEqual(["match.vote"]);
  });

  test.each(["briefing", "intel", "comms", "debrief"] as SpyPhase[])(
    "a seat that ended the %s phase has no legal action",
    (phase) => {
      const st = { ...game.newMatch(baseConfig(), "s"), phase };
      expect(tools(st)).toContain("match.submit_phase_end");
      const ended = game.submit(st, seat0, {}).state;
      expect(tools(ended)).toEqual([]);
      expect(tools(ended, seat1)).toContain("match.submit_phase_end");
    },
  );

  test("a team member that has acted on the operation has no legal action", () => {
    const base = game.newMatch(baseConfig(), "s");
    const st = {
      ...base,
      phase: "operation" as SpyPhase,
      proposal: { proposalId: "p", leader: seat0, team: [seat0, seat1], opIndex: 0 },
    };
    expect(tools(st)).toEqual(["match.mission_action"]);
    const acted = game.submit(st, seat0, { sabotage: false }).state;
    expect(tools(acted)).toEqual([]);
    expect(tools(acted, seat1)).toEqual(["match.mission_action"]);
  });

  test("a second vote is rejected", () => {
    const st = { ...game.newMatch(baseConfig(), "s"), phase: "vote" as SpyPhase };
    const voted = game.submit(st, seat0, { vote: "approve" }).state;
    const again = game.submit(voted, seat0, { vote: "reject" });
    expect(again.accepted).toBe(false);
    expect(again.state.votes[seat0]).toBe("approve");
  });

  test("a speech act after ending comms is rejected", () => {
    const st = { ...game.newMatch(baseConfig(), "s"), phase: "comms" as SpyPhase };
    const ended = game.submit(st, seat0, {}).state;
    const late = game.submit(ended, seat0, { act: "pass" });
    expect(late.accepted).toBe(false);
    expect(late.state.log).toEqual([]);
  });

  test("mole-only intel tools are listed for moles and hidden from loyals", () => {
    const base = game.newMatch(baseConfig(), "gate");
    const st = { ...base, phase: "intel" as SpyPhase };
    const mole = st.seats.find((s) => st.deal.alignmentBySeat[s] === "mole");
    const loyal = st.seats.find((s) => st.deal.alignmentBySeat[s] === "loyal");
    if (mole === undefined || loyal === undefined) throw new Error("expected both roles");
    const moleOnly = ["intel.plant_misinfo", "intel.counterintel", "intel.protect_source"];
    for (const t of moleOnly) {
      expect(tools(st, mole)).toContain(t);
      expect(tools(st, loyal)).not.toContain(t);
    }
    for (const t of ["intel.scan_alignment", "intel.audit_statement", "intel.trace_operation"]) {
      expect(tools(st, loyal)).toContain(t);
    }
  });
});

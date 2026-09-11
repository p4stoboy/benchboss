import { describe, expect, test } from "bun:test";
import {
  type Command,
  type MatchHandle,
  type MatchSession,
  isTerminal,
  newSession,
  observe,
  sessionLog,
  sessionState,
  step,
} from "@benchboss/referee";
import type { Observation } from "@benchboss/schemas";
import { SPY_PHASE_TOOLS, currentPhase, isReady, makeSpyGame, spySafeDefault } from "../src/index";
import type { SpyState } from "../src/index";
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

function newServer(seed = "srv-seed") {
  const game = makeSpyGame();
  const config = baseConfig();
  return harness(
    newSession<SpyState>({
      game,
      config,
      seed,
      phaseToTools: SPY_PHASE_TOOLS,
      currentPhase,
      isReady,
      safeDefault: spySafeDefault,
    }),
  );
}

describe("spy MatchServer integration", () => {
  test("server_writes_a_seed_commit_event_on_construction", () => {
    const server = newServer();
    const kinds = sessionLog(server.get()).map((e) => e.kind);
    expect(kinds).toContain("rng.commit");
  });

  test("belief_sample_worlds_is_not_a_server_tool", () => {
    const allTools = Object.values(SPY_PHASE_TOOLS).flat();
    expect(allTools).not.toContain("belief.sample_worlds");
  });

  test("comms_send_spends_one_tool_call_from_the_budget", () => {
    const server = newServer();
    // advance to comms: every seat ends briefing, then intel.
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    expect(seat0).toBeDefined();
    if (seat0 === undefined) throw new Error("no seat 0");
    const token = seat0;
    // briefing -> intel -> comms via submit_phase_end from all seats twice.
    for (const phase of ["briefing", "intel"]) {
      for (const s of seats) {
        const tk = s;
        server.advance({ kind: "callTool", seat: tk, tool: "match.submit_phase_end", input: {} });
      }
    }
    expect(currentPhase(sessionState(server.get()))).toBe("comms");
    // Trigger the per-turn ledger reset for this seat (first callTool in the new
    // phase resets the budget; getObservation alone does not). A warmup pass
    // opens the turn, then we measure before/after a second send.
    server.advance({ kind: "callTool", seat: token, tool: "comms.send", input: { act: "pass" } });
    const budgetsBefore = (observe(server.get(), token) as { budgets: Record<string, number> })
      .budgets;
    const before = budgetsBefore.toolCallsPerTurn;
    expect(before).toBeDefined();
    if (before === undefined) throw new Error("toolCallsPerTurn budget missing");
    server.advance({ kind: "callTool", seat: token, tool: "comms.send", input: { act: "pass" } });
    const budgetsAfter = (observe(server.get(), token) as { budgets: Record<string, number> })
      .budgets;
    const after = budgetsAfter.toolCallsPerTurn;
    expect(after).toBeDefined();
    if (after === undefined) throw new Error("toolCallsPerTurn budget missing after");
    expect(after).toBe(before - 1);
  });

  test("comms_send_lands_a_typed_speech_act_in_the_public_log", () => {
    // Pillar A validated END-TO-END: a comms.send through the server boundary
    // commits a TYPED SpeechActRecord into the public log (match://current/log),
    // proving the anti-free-text grammar holds at the server, not just the schema.
    const server = newServer();
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    const seat1 = seats[1];
    const seat2 = seats[2];
    expect(seat0).toBeDefined();
    expect(seat1).toBeDefined();
    expect(seat2).toBeDefined();
    if (seat0 === undefined || seat1 === undefined || seat2 === undefined)
      throw new Error("seats 0/1/2 must exist");
    for (const phase of ["briefing", "intel"]) {
      for (const s of seats)
        server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
    }
    expect(currentPhase(sessionState(server.get()))).toBe("comms");
    const token = seat0;
    const r = server.advance({
      kind: "callTool",
      seat: token,
      tool: "comms.send",
      input: {
        act: "accuse",
        target: seat2,
        confidence: 0.7,
      },
    });
    expect(r.ok).toBe(true);
    // The committed act is a typed record in the public log — no free text.
    const obs = observe(server.get(), token) as {
      publicState: { log: Array<Record<string, unknown>> };
    };
    const maybeLanded = obs.publicState.log.at(-1);
    expect(maybeLanded).toBeDefined();
    if (maybeLanded === undefined) throw new Error("no last log entry");
    const landed: Record<string, unknown> = maybeLanded;
    expect(landed.seat).toBe(seat0);
    expect(landed.act).toBe("accuse");
    expect(landed.target).toBe(seat2);
    expect(landed).not.toHaveProperty("message");
    // Same act is visible in the public log of every other seat (server-brokered).
    const otherLog = (
      observe(server.get(), seat1) as {
        publicState: { log: Array<Record<string, unknown>> };
      }
    ).publicState.log;
    const maybeOtherLast = otherLog.at(-1);
    expect(maybeOtherLast).toBeDefined();
    if (maybeOtherLast === undefined) throw new Error("no last log entry for other seat");
    expect(maybeOtherLast.act).toBe("accuse");
  });

  test("rejected_proposal_retries_then_commits_the_safe_default", () => {
    const server = newServer();
    const seats = sessionState(server.get()).seats;
    // drive to proposal phase.
    for (const phase of ["briefing", "intel", "comms"]) {
      for (const s of seats)
        server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
    }
    expect(currentPhase(sessionState(server.get()))).toBe("proposal");
    const maybeLeader = sessionState(server.get()).seats[sessionState(server.get()).leaderIdx];
    expect(maybeLeader).toBeDefined();
    if (maybeLeader === undefined) throw new Error("no leader seat");
    const leader = maybeLeader;
    const token = leader;
    // submit an illegal team (wrong size) until invalidRetries exhausts -> safe default.
    const r1 = server.advance({
      kind: "callTool",
      seat: token,
      tool: "match.propose_team",
      input: { team: [leader] },
    });
    expect(r1.ok).toBe(false);
    const r2 = server.advance({
      kind: "callTool",
      seat: token,
      tool: "match.propose_team",
      input: { team: [leader] },
    });
    expect(r2.ok).toBe(false);
    server.advance({
      kind: "callTool",
      seat: token,
      tool: "match.propose_team",
      input: { team: [leader] },
    });
    // after invalidRetries(2) exhausted the server commits spySafeDefault.
    const finalProposal = sessionState(server.get()).proposal;
    expect(finalProposal).not.toBeNull();
    if (finalProposal === null) throw new Error("proposal should not be null");
    expect(finalProposal.team.length).toBe(2);
  });

  test("getObservation_injects_legalTools_as_non_empty_for_leader_in_proposal", () => {
    const server = newServer();
    const seats = sessionState(server.get()).seats;
    // drive to proposal phase.
    for (const phase of ["briefing", "intel", "comms"]) {
      for (const s of seats)
        server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
    }
    expect(currentPhase(sessionState(server.get()))).toBe("proposal");
    const state = sessionState(server.get()) as SpyState;
    const maybeLeader = state.seats[state.leaderIdx];
    expect(maybeLeader).toBeDefined();
    if (maybeLeader === undefined) throw new Error("no leader seat");
    const token = maybeLeader;
    const obs = observe(server.get(), token) as Observation;
    expect(obs.legalTools).toBeDefined();
    expect(obs.legalTools.length).toBeGreaterThan(0);
  });

  test("rng_reveal_is_written_on_terminal_via_hammer_five_rejected_proposals", () => {
    const server = newServer();
    const seats = sessionState(server.get()).seats;
    // Drive briefing -> intel -> comms -> proposal (first entry).
    for (const phase of ["briefing", "intel", "comms"]) {
      for (const s of seats)
        server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
    }
    expect(currentPhase(sessionState(server.get()))).toBe("proposal");

    // Five consecutive rejected proposals trigger the hammer (rejectStreak >= 5).
    // After each rejection the phase returns to "proposal" with the next leader.
    for (let i = 0; i < 5; i++) {
      expect(currentPhase(sessionState(server.get()))).toBe("proposal");
      const state = sessionState(server.get()) as SpyState;
      const maybeLeader = state.seats[state.leaderIdx];
      expect(maybeLeader).toBeDefined();
      if (maybeLeader === undefined) throw new Error(`no leader at rejection ${i}`);
      const leaderToken = maybeLeader;
      // Build a valid 2-seat team for opIndex 0 with 5 players.
      const otherSeat = state.seats.find((s) => s !== maybeLeader);
      expect(otherSeat).toBeDefined();
      if (otherSeat === undefined) throw new Error(`no second seat at rejection ${i}`);
      const propResult = server.advance({
        kind: "callTool",
        seat: leaderToken,
        tool: "match.propose_team",
        input: { team: [maybeLeader, otherSeat] },
      });
      expect(propResult.ok).toBe(true);
      // All seats vote reject.
      for (const s of seats) {
        server.advance({
          kind: "callTool",
          seat: s,
          tool: "match.vote",
          input: { vote: "reject" },
        });
      }
      // After the 5th rejection the game is terminal; don't assert phase after that.
      if (i < 4) {
        expect(currentPhase(sessionState(server.get()))).toBe("proposal");
      }
    }

    expect(isTerminal(server.get())).toBe(true);
    const allKinds = sessionLog(server.get()).map((e) => e.kind);
    expect(allKinds.some((k) => k === "rng.reveal")).toBe(true);
  });
});

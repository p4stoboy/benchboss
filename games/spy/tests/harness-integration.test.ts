import { describe, expect, test } from "bun:test";
import type { SeatId } from "@benchboss/core";
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
import { makeSpyGame } from "../src/game";
import { teamSize } from "../src/missions";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import { spySenseResolvers } from "../src/sensing";
import type { SpyState } from "../src/types";
import { runSpyMatch, verifySpyReplay } from "./harness";
import { handlerConfig } from "./helpers";

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

// Builds a server the SAME way the production runner (runSpyMatch handler-variant)
// does: handler config + the full M3 resolver set + the PUBLIC spectator
// summaries (winner/reason on terminal; op count/result on resolve). This is the
// production wiring, not an isolated unit fixture.
function handlerServer(seed: string): MatchHandle<SpyState> {
  return harness(
    newSession<SpyState>({
      game: makeSpyGame(),
      config: handlerConfig(),
      seed,
      phaseToTools: SPY_PHASE_TOOLS,
      currentPhase,
      isReady,
      safeDefault: spySafeDefault,
      senseResolvers: spySenseResolvers(seed),
      terminalSummary: (s) => ({ winner: s.winner, reason: s.winReason }),
      resolveSummary: (s, resolvedPhase) => {
        if (resolvedPhase !== "operation") return {};
        const op = s.opResults.at(-1);
        if (op === undefined) return {};
        return { result: op.failed ? "fail" : "success", sabotageCount: op.sabotageCount };
      },
    }),
  );
}

function toIntelPhase(server: MatchHandle<SpyState>): void {
  // briefing -> intel: every seat ends briefing.
  for (const s of sessionState(server.get()).seats) {
    server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
  }
}

describe("I2: M3 deception wired through the production runner", () => {
  test("mole_plant_misinfo_spends_intel_points_not_tool_calls_through_callTool", () => {
    const server = handlerServer("i2-plant");
    toIntelPhase(server);
    expect(currentPhase(sessionState(server.get()))).toBe("intel");

    const st = sessionState(server.get());
    const mole = st.deal.moleSeats[0];
    expect(mole).toBeDefined();
    if (mole === undefined) throw new Error("expected a mole seat");
    const target = st.seats.find((s) => s !== mole);
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("expected a target seat");
    const token = mole;

    // Warmup call opens the turn (triggers ledger.reset) and gives a stable
    // "before" baseline.
    const warmup = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.plant_misinfo",
      input: { target },
    });
    expect(warmup.ok).toBe(true);
    const before = (warmup.observation as { budgets: Record<string, number> }).budgets;
    expect(before.intelOrScoutPoints).toBeDefined();
    expect(before.toolCallsPerTurn).toBeDefined();
    if (before.intelOrScoutPoints === undefined || before.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing before");

    const r = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.plant_misinfo",
      input: { target },
    });
    expect(r.ok).toBe(true);
    const after = (observe(server.get(), token) as { budgets: Record<string, number> }).budgets;
    expect(after.intelOrScoutPoints).toBeDefined();
    expect(after.toolCallsPerTurn).toBeDefined();
    if (after.intelOrScoutPoints === undefined || after.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing after");

    // M3 deception sensing spends the SENSING budget, never toolCallsPerTurn,
    // and never advances the phase.
    expect(after.intelOrScoutPoints).toBe(before.intelOrScoutPoints - 1);
    expect(after.toolCallsPerTurn).toBe(before.toolCallsPerTurn);
    expect(currentPhase(sessionState(server.get()))).toBe("intel");
    // The plant landed privately in the mole's state.
    expect(sessionState(server.get()).misinfoFlags[target]).toBe(true);
  });

  test("handler_variant_runner_log_replays_byte_identical_with_handler_flag", () => {
    // minor: verifySpyReplay must thread `handler` so a handler match replays
    // byte-identically; without it the deal differs and replay diverges.
    const { jsonl } = runSpyMatch({ seed: "i2-replay", handler: true });
    const ok = verifySpyReplay({ jsonl, seed: "i2-replay", handler: true });
    expect(ok.ok).toBe(true);
    expect(ok.divergenceSeq).toBeUndefined();
    // Omitting handler diverges (the M3 deal is different) — proves the thread matters.
    const bad = verifySpyReplay({ jsonl, seed: "i2-replay" });
    expect(bad.ok).toBe(false);
    expect(bad.divergenceSeq).toBeDefined();
  });
});

describe("I3: assassin endgame driven through step()/the server end-to-end", () => {
  // Drive a handler-variant match through the server with loyal-only teams so the
  // Loyals reach 3 successes; the 3-successes->assassinate transition happens via
  // pm.resolve() -> game.step(), and the Mole's guess resolves to terminal.
  function driveToAssassinate(seed: string): MatchHandle<SpyState> {
    const server = handlerServer(seed);
    const tok = (s: SeatId) => s;
    let guard = 0;
    while (!isTerminal(server.get()) && guard < 500) {
      guard++;
      const st = sessionState(server.get());
      switch (st.phase) {
        case "briefing":
        case "intel":
        case "comms":
        case "debrief": {
          for (const s of st.seats)
            server.advance({
              kind: "callTool",
              seat: tok(s),
              tool: "match.submit_phase_end",
              input: {},
            });
          break;
        }
        case "proposal": {
          const leader = st.seats[st.leaderIdx];
          if (leader === undefined) throw new Error("no leader");
          const size = teamSize(st.seats.length, st.opIndex);
          const loyals = st.seats.filter((s) => st.deal.alignmentBySeat[s] === "loyal");
          const team = loyals.slice(0, size);
          server.advance({
            kind: "callTool",
            seat: tok(leader),
            tool: "match.propose_team",
            input: { team },
          });
          break;
        }
        case "vote": {
          for (const s of st.seats)
            server.advance({
              kind: "callTool",
              seat: tok(s),
              tool: "match.vote",
              input: { vote: "approve" },
            });
          break;
        }
        case "operation": {
          const team = st.proposal ? st.proposal.team : [];
          for (const s of team)
            server.advance({
              kind: "callTool",
              seat: tok(s),
              tool: "match.mission_action",
              input: { sabotage: false },
            });
          break;
        }
        case "assassinate":
          // Stop here — the caller submits the guess so it can assert per-case.
          return server;
      }
    }
    return server;
  }

  test("three_loyal_successes_reach_assassinate_via_step_and_correct_guess_wins_for_mole", () => {
    const server = driveToAssassinate("i3-correct");
    const st = sessionState(server.get());
    expect(st.phase).toBe("assassinate");
    expect(st.successes).toBe(3);
    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");
    const handler = st.deal.handlerSeat;
    expect(handler).not.toBeNull();
    if (handler === null) throw new Error("handlerSeat is null");

    // The assassin guesses the handler CORRECTLY -> Mole win. The
    // assassinate->terminal transition runs through pm.resolve()/game.step().
    const r = server.advance({
      kind: "callTool",
      seat: assassin,
      tool: "match.assassinate",
      input: { target: handler },
    });
    expect(r.ok).toBe(true);
    expect(isTerminal(server.get())).toBe(true);
    const final = sessionState(server.get());
    expect(final.winner).toBe("mole");
    expect(final.winReason).toBe("assassin");

    // The terminal event carries the public winner/reason for the viewer.
    const terminal = sessionLog(server.get()).find((e) => e.kind === "match.terminal");
    expect(terminal).toBeDefined();
    if (terminal === undefined) throw new Error("no terminal event");
    expect(terminal.payload.winner).toBe("mole");
    expect(terminal.payload.reason).toBe("assassin");
  });

  test("wrong_guess_in_assassinate_resolves_to_loyal_win_through_the_server", () => {
    const server = driveToAssassinate("i3-wrong");
    const st = sessionState(server.get());
    expect(st.phase).toBe("assassinate");
    expect(st.successes).toBe(3);
    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");
    const handler = st.deal.handlerSeat;
    expect(handler).not.toBeNull();
    if (handler === null) throw new Error("handlerSeat is null");
    const wrong = st.seats.find((s) => s !== handler && st.deal.alignmentBySeat[s] === "loyal");
    expect(wrong).toBeDefined();
    if (wrong === undefined) throw new Error("expected a wrong loyal target");

    const r = server.advance({
      kind: "callTool",
      seat: assassin,
      tool: "match.assassinate",
      input: { target: wrong },
    });
    expect(r.ok).toBe(true);
    expect(isTerminal(server.get())).toBe(true);
    expect(sessionState(server.get()).winner).toBe("loyal");
  });
});

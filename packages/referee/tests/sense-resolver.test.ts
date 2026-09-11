import { describe, expect, test } from "bun:test";
import { mkSeatId, verifyReplay } from "@benchboss/core";
import type { MatchConfig } from "@benchboss/core";
import type { LegacyObservation as Observation } from "@benchboss/schemas";
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
} from "../src/index";
import type { LegacySenseResolver as SenseResolver } from "../src/index";
import { makeRpsN } from "./fixtures/round-game";
import type { RpsState } from "./fixtures/round-game";

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

// A SYNTHETIC read-only sensing tool over rps-n: peeks the public round number.
// budgetKey: intelOrScoutPoints; cost 1; pure read (nextState === state).
const peekRoundResolver: SenseResolver<RpsState> = {
  tool: "match.peek_round",
  budgetKey: "intelOrScoutPoints",
  cost: () => 1,
  resolve: (state) => ({ result: { round: state.round }, nextState: state }),
};

// rps-n's throw phase plus the sensing tool, so the tool is phase-legal.
const senseToolsRpsN: Record<string, string[]> = {
  throw: ["match.throw", "match.peek_round"],
  resolve: [],
  terminal: [],
};

function cfg(intel: number, n = 2): MatchConfig {
  return {
    matchId: "m-sense",
    gameId: "rps-n",
    seats: Array.from({ length: n }, (_, i) => mkSeatId(i)),
    rules: { rounds: 1 },
    budgets: {
      wallClockMsPerDecision: 5000,
      toolCallsPerTurn: 5,
      intelOrScoutPoints: intel,
      simRolloutsPerTurn: 0,
      invalidRetries: 1,
    },
  };
}

function server(config: MatchConfig, seed = "sense-seed") {
  return harness(
    newSession<RpsState>({
      game: {
        ...makeRpsN(),
        legalActions: (state, seat) => [
          ...makeRpsN().legalActions(state, seat),
          {
            tool: "match.peek_round",
            phase: "throw",
            jsonSchema: { type: "object", additionalProperties: false },
          },
        ],
      },
      config,
      seed,
      phaseToTools: senseToolsRpsN,
      currentPhase: (s) => s.phase,
      isReady: (s) => config.seats.every((seat) => s.committed[seat] !== null),
      safeDefault: () => ({ throw: "rock" }),
      senseResolvers: [peekRoundResolver],
    }),
  );
}

describe("match server — sensing budget at the boundary", () => {
  test("spends_intel_or_scout_points_and_returns_private_result", () => {
    const config = cfg(1);
    const srv = server(config);
    const seat = mkSeatId(0);

    // Read budget BEFORE the sensing call via the pull-only snapshot.
    const before = observe(srv.get(), seat) as Observation;
    const budgetBefore = before.budgets.intelOrScoutPoints;
    const toolCallsPerTurnBefore = before.budgets.toolCallsPerTurn;
    expect(budgetBefore).toBeDefined();
    expect(toolCallsPerTurnBefore).toBeDefined();

    const res = srv.advance({ kind: "callTool", seat, tool: "match.peek_round", input: {} });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("sensing served");
    expect(res.result).toEqual({ round: 0 });

    // Read budget AFTER from the observation returned with the tool result.
    const after = res.observation as Observation;
    const budgetAfter = after.budgets.intelOrScoutPoints;
    const toolCallsPerTurnAfter = after.budgets.toolCallsPerTurn;
    expect(budgetAfter).toBeDefined();
    expect(toolCallsPerTurnAfter).toBeDefined();

    // The sensing call must have consumed exactly 1 intelOrScoutPoints.
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect().toBeDefined() above
    expect(budgetAfter!).toBe(budgetBefore! - 1);

    // Sensing must NOT consume a per-turn tool call; toolCallsPerTurn is unchanged.
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect().toBeDefined() above
    expect(toolCallsPerTurnAfter!).toBe(toolCallsPerTurnBefore!);
  });

  test("refuses_with_intel_or_scout_points_exhausted_once_spent", () => {
    const config = cfg(1);
    const srv = server(config);
    expect(
      srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} }).ok,
    ).toBe(true); // spends the only point
    const second = srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.peek_round",
      input: {},
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("intelOrScoutPoints-exhausted");
  });

  test("sensing_does_not_advance_the_phase_or_commit_a_throw", () => {
    const config = cfg(2);
    const srv = server(config);
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    // No throw was committed; the match is still in the throw phase, not over.
    expect(sessionState(srv.get()).phase).toBe("throw");
    const seat0 = mkSeatId(0);
    const committed = sessionState(srv.get()).committed[seat0];
    expect(committed).toBeNull();
    expect(isTerminal(srv.get())).toBe(false);
  });

  test("logs_a_sense_serve_event_with_tool_and_cost_only", () => {
    const config = cfg(1);
    const srv = server(config);
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    const ev = sessionLog(srv.get()).find((e) => e.kind === "sense.serve");
    expect(ev).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(ev).toBeDefined() above
    const payload = ev!.payload;
    expect(payload).toEqual({ tool: "match.peek_round", cost: 1 });
    // Key-exhaustive: the payload must contain ONLY tool and cost — nothing else.
    expect(Object.keys(payload)).toEqual(["tool", "cost"]);
    // Leak-free: the public log carries no hidden-state-revealing content.
    expect(JSON.stringify(payload)).not.toContain("throw");
  });

  test("replay_reproduces_a_match_that_included_sensing", () => {
    const config = cfg(2);
    const srv = server(config, "sense-term");
    // Seat A senses (twice, spending its 2 intel points) BEFORE throwing.
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "rock" },
    });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(1),
      tool: "match.throw",
      input: { throw: "scissors" },
    });
    expect(isTerminal(srv.get())).toBe(true);

    const res = verifyReplay({
      game: {
        ...makeRpsN(),
        legalActions: (state, seat) => [
          ...makeRpsN().legalActions(state, seat),
          {
            tool: "match.peek_round",
            phase: "throw",
            jsonSchema: { type: "object", additionalProperties: false },
          },
        ],
      },
      config,
      seed: "sense-term",
      log: [...sessionLog(srv.get())],
    });
    expect(res.ok).toBe(true);
    expect(res.divergenceSeq).toBeUndefined();
  });
});

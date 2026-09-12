import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import type { MatchConfig } from "@benchboss/core";
import type { Observation } from "@benchboss/protocol";
import {
  type Command,
  type MatchHandle,
  type MatchSession,
  type SessionOptions,
  isTerminal,
  newSession,
  observe,
  sessionLog,
  sessionState,
  step,
  verifySessionReplay,
} from "../src/index";
import type { SenseResolver } from "../src/index";
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
// Each read spends one research unit without changing game state.
const peekRoundResolver: SenseResolver<RpsState> = {
  tool: "match.peek_round",
  resource: "research",
  cost: () => 1,
  resolve: (state) => ({ result: { round: state.round }, nextState: state }),
};

// rps-n's throw phase plus the sensing tool, so the tool is phase-legal.
const senseToolsRpsN: Record<string, string[]> = {
  throw: ["match.throw", "match.peek_round"],
  resolve: [],
  terminal: [],
};

function cfg(research: number, n = 2): MatchConfig {
  return {
    matchId: "m-sense",
    gameId: "rps-n",
    seats: Array.from({ length: n }, (_, i) => mkSeatId(i)),
    rules: { rounds: 1 },
    identity: { protocolVersion: 1, runtimeVersion: "0.1.0", gameId: "rps-n", revision: "1.0.0" },
    timing: {
      playerTotalMs: null,
      decisionLimitMs: 5000,
      phaseLimits: {},
      clockVisibility: "private",
    },
    resources: {
      research: { amount: research, reset: "match", visibility: "private" },
      actions: { amount: 5, reset: "phase", visibility: "private" },
    },
    metering: { action: { resource: "actions", cost: 1 } },
  };
}

function sessionOptions(config: MatchConfig, seed: string): SessionOptions<RpsState> {
  return {
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
    defaultAction: () => ({ tool: "match.throw", input: { throw: "rock" } }),
    senseResolvers: [peekRoundResolver],
  };
}

function server(config: MatchConfig, seed = "sense-seed") {
  return harness(newSession(sessionOptions(config, seed)));
}

describe("match server — sensing resources at the boundary", () => {
  test("spends_research_and_returns_private_result_without_spending_action_resources", () => {
    const config = cfg(1);
    const srv = server(config);
    const seat = mkSeatId(0);

    const before = observe(srv.get(), seat) as Observation;
    const researchBefore = before.resources.research;
    const actionsBefore = before.resources.actions;
    expect(researchBefore).toBeDefined();
    expect(actionsBefore).toBeDefined();

    const res = srv.advance({ kind: "callTool", seat, tool: "match.peek_round", input: {} });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("sensing served");
    expect(res.result).toEqual({ round: 0 });

    const after = res.observation as Observation;
    const researchAfter = after.resources.research;
    const actionsAfter = after.resources.actions;
    expect(researchAfter).toBeDefined();
    expect(actionsAfter).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: guarded by expect().toBeDefined() above
    expect(researchAfter!).toBe(researchBefore! - 1);

    expect(actionsAfter).toBe(actionsBefore);
  });

  test("refuses_with_research_exhausted_once_spent", () => {
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
    expect(second.reason).toBe("research-exhausted");
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

  test("logs_sensing_metadata_without_the_private_answer", () => {
    const config = cfg(1);
    const srv = server(config);
    srv.advance({ kind: "callTool", seat: mkSeatId(0), tool: "match.peek_round", input: {} });
    const ev = sessionLog(srv.get()).find((e) => e.kind === "sense.serve");
    expect(ev).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(ev).toBeDefined() above
    const payload = ev!.payload;
    expect(payload).toEqual({ tool: "match.peek_round", resource: "research", cost: 1 });
    expect(Object.keys(payload)).toEqual(["tool", "resource", "cost"]);
    // Leak-free: the public log carries no hidden-state-revealing content.
    expect(JSON.stringify(payload)).not.toContain("throw");
  });

  test("replay_reproduces_a_match_that_included_sensing", () => {
    const config = cfg(2);
    const srv = server(config, "sense-term");
    // Seat A spends both research units before throwing.
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

    const res = verifySessionReplay({
      options: sessionOptions(config, "sense-term"),
      log: [...sessionLog(srv.get())],
    });
    expect(res.ok).toBe(true);
    expect(res.divergenceSeq).toBeUndefined();
  });
});

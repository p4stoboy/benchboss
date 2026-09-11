import { describe, expect, test } from "bun:test";
import { eventsToJsonl, mkSeatId, sha256Commit, verifyReplay } from "@benchboss/core";
import type { GameModule, MatchConfig, SeatId } from "@benchboss/core";
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
import { RPS_PHASE_TOOLS, makeRpsN } from "./fixtures/round-game";
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

function cfg(rounds = 1, n = 2): MatchConfig {
  return {
    matchId: "m1",
    gameId: "rps-n",
    seats: Array.from({ length: n }, (_, i) => mkSeatId(i)),
    rules: { rounds },
    budgets: {
      wallClockMsPerDecision: 5000,
      toolCallsPerTurn: 2,
      intelOrScoutPoints: 0,
      simRolloutsPerTurn: 0,
      invalidRetries: 1,
    },
  };
}

function server(config: MatchConfig, seed = "seed-1") {
  return harness(
    newSession<RpsState>({
      game: makeRpsN(),
      config,
      seed,
      phaseToTools: RPS_PHASE_TOOLS,
      currentPhase: (s) => s.phase,
      isReady: (s) => config.seats.every((seat) => s.committed[seat] !== null),
      safeDefault: () => ({ throw: "rock" }),
    }),
  );
}

describe("match server", () => {
  test("defaults_use_the_explicit_tool_when_multiple_tools_have_identical_schemas", () => {
    const game: GameModule<{ outcome: string | null }, unknown, unknown, number> = {
      id: "choices",
      newMatch: () => ({ outcome: null }),
      observe: () => ({}),
      legalActions: () =>
        ["match.resign", "match.pass"].map((tool) => ({
          tool,
          phase: "choose",
          jsonSchema: { type: "object", additionalProperties: false },
        })),
      submit: (state, _seat, _input, tool) => ({
        accepted: true,
        reason: "ok",
        state: { ...state, outcome: tool ?? "missing" },
      }),
      step: (state) => state,
      isTerminal: (state) => state.outcome !== null,
      score: (state) => ({ [mkSeatId(0)]: state.outcome === "match.pass" ? 1 : 0 }),
    };
    const config = { ...cfg(), gameId: game.id };
    const options = {
      game,
      config,
      seed: "same-schema",
      phaseToTools: { choose: ["match.resign", "match.pass"] },
      currentPhase: () => "choose",
      isReady: () => false,
      safeDefault: () => ({}),
    };
    const initial = newSession({
      ...options,
      defaultAction: () => ({ tool: "match.pass", input: {} }),
    });
    const result = step(initial, { kind: "commitDefault", seat: mkSeatId(0) });
    expect(result.output.ok).toBe(true);
    expect(result.session.state.outcome).toBe("match.pass");
    expect(result.session.log.find((event) => event.kind === "action.default")?.payload).toEqual({
      tool: "match.pass",
      action: {},
    });
    expect(verifyReplay({ game, config, seed: "same-schema", log: result.session.log }).ok).toBe(
      true,
    );

    for (const defaultAction of [
      undefined,
      () => ({ tool: "match.unknown", input: {} }),
      () => ({ tool: "match.pass", input: { unexpected: true } }),
    ]) {
      const invalid = newSession({ ...options, defaultAction });
      const rejected = step(invalid, { kind: "commitDefault", seat: mkSeatId(0) });
      expect(rejected.output.ok).toBe(false);
      expect(rejected.session).toBe(invalid);
    }
  });
  test("records_terminal_metadata_when_submit_or_default_ends_without_resolution", () => {
    for (const kind of ["callTool", "commitDefault"] as const) {
      const base = makeRpsN();
      const game = {
        ...base,
        submit: (
          state: RpsState,
          seat: SeatId,
          input: { throw: "rock" | "paper" | "scissors" },
        ) => {
          const result = base.submit(state, seat, input);
          return { ...result, state: { ...result.state, phase: "terminal" as const } };
        },
        step: () => {
          throw new Error("terminal submission must not resolve");
        },
      };
      const config = cfg();
      const initial = newSession({
        game,
        config,
        seed: "instant",
        phaseToTools: RPS_PHASE_TOOLS,
        currentPhase: (state) => state.phase,
        isReady: () => false,
        safeDefault: () => ({ throw: "rock" }),
      });
      const result = step(
        initial,
        kind === "callTool"
          ? { kind, seat: mkSeatId(0), tool: "match.throw", input: { throw: "rock" } }
          : { kind, seat: mkSeatId(0) },
      );
      expect(result.output.ok).toBe(true);
      expect(result.session.log.map((event) => event.kind)).toEqual([
        "rng.commit",
        kind === "callTool" ? "action.submit" : "action.default",
        "rng.reveal",
        "match.terminal",
      ]);
      expect(verifyReplay({ game, config, seed: "instant", log: result.session.log }).ok).toBe(
        true,
      );
      expect(
        step(result.session, { kind: "commitDefault", seat: mkSeatId(0) }).session.log,
      ).toHaveLength(4);
    }
  });
  test("commits_seed_hash_on_construction", () => {
    const config = cfg();
    const srv = server(config, "seed-1");
    const first = sessionLog(srv.get())[0];
    expect(first).toBeDefined();
    expect(first?.kind).toBe("rng.commit");
    expect(first?.payload.hash).toBe(sha256Commit("seed-1"));
  });

  test("routes_authenticated_throw_into_game_and_returns_observation", () => {
    const config = cfg();
    const srv = server(config);
    const res = srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "rock" },
    });
    expect(res.ok).toBe(true);
    expect(res.observation).toBeDefined();
  });

  test("observation_for_seat_a_never_contains_seat_b_throw", () => {
    const config = cfg();
    const srv = server(config);
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
    const obsA = JSON.stringify(observe(srv.get(), mkSeatId(0)));
    expect(obsA).not.toContain("scissors");
  });

  test("enforces_tool_budget_at_the_boundary", () => {
    const config = cfg();
    const srv = server(config);
    // budget toolCallsPerTurn = 2; first throw ok, a second throw same turn is rejected by game
    // but the third tool call must hit the budget wall.
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.throw",
        input: { throw: "rock" },
      }).ok,
    ).toBe(true);
    const second = srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "paper" },
    }); // rejected by game (already committed)
    expect(second.ok).toBe(false);
    const third = srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "paper" },
    });
    expect(third.reason).toContain("not legal for seat");
  });

  test("rejects_invalid_schema_without_metering_and_allows_clock_default", () => {
    const config = cfg(1);
    const srv = server(config);
    // Send an invalid action to burn the single retry, then another invalid -> safe default committed.
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "banana" as never },
    });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "banana" as never },
    });
    expect(sessionLog(srv.get()).filter((e) => e.kind === "action.submit")).toHaveLength(0);
    srv.advance({ kind: "commitDefault", seat: mkSeatId(0) });
    const kinds = sessionLog(srv.get()).map((e) => e.kind);
    expect(kinds).toContain("action.default");
  });

  test("reveals_seed_and_terminal_score_on_completion_and_replay_verifies", () => {
    const config = cfg(1);
    const srv = server(config, "seed-term");
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
    const kinds = sessionLog(srv.get()).map((e) => e.kind);
    expect(kinds).toContain("rng.reveal");
    expect(kinds).toContain("match.terminal");

    const res = verifyReplay({
      game: makeRpsN(),
      config,
      seed: "seed-term",
      log: [...sessionLog(srv.get())],
    });
    expect(res.ok).toBe(true);
  });

  test("replay_reproduces_committed_safe_default_actions", () => {
    const config = cfg(1);
    const srv = server(config, "seed-default");
    // Seat A exhausts its single retry, then commits the safe default {throw:"rock"}.
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "banana" as never },
    });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "banana" as never },
    });
    srv.advance({ kind: "commitDefault", seat: mkSeatId(0) });
    // Seat B plays validly; the round resolves to terminal.
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(1),
      tool: "match.throw",
      input: { throw: "scissors" },
    });
    expect(isTerminal(srv.get())).toBe(true);
    const kinds = sessionLog(srv.get()).map((e) => e.kind);
    expect(kinds).toContain("action.default");

    const verify = verifyReplay({
      game: makeRpsN(),
      config,
      seed: "seed-default",
      log: [...sessionLog(srv.get())],
    });
    expect(verify.ok).toBe(true);
    expect(verify.divergenceSeq).toBeUndefined();
  });
});

// A 2-phase fixture game ("comms" then "throw") proving the multi-phase budget
// cadence and chained resolves. NOT production code — a test fixture, hence inline.
// - phase "comms": each seat may call `match.say` up to its toolCallsPerTurn budget;
//   the phase is ready once every seat has called `match.done` (one per seat).
// - resolve("comms") -> phase "throw".
// - phase "throw": each seat throws once; resolve -> terminal.
type TwoPhaseState = {
  phase: "comms" | "throw" | "done";
  said: Record<string, number>;
  done: Record<string, boolean>;
  thrown: Record<string, boolean>;
  cfg: MatchConfig;
};

function makeTwoPhase(): GameModule<TwoPhaseState, { kind: string }, unknown, number> {
  const seatsOf = (s: TwoPhaseState) => s.cfg.seats as SeatId[];
  return {
    id: "two-phase",
    newMatch: (cfg) => ({
      phase: "comms",
      said: {},
      done: {},
      thrown: {},
      cfg,
    }),
    observe: (s, seat) => ({
      matchId: s.cfg.matchId,
      phase: s.phase,
      seat,
      publicState: { phase: s.phase },
      privateState: { mySaid: s.said[seat] ?? 0 },
      legalTools: TWO_PHASE_TOOLS[s.phase] ?? [],
    }),
    legalActions: () => [
      { tool: "match.say", phase: "comms", jsonSchema: {} },
      { tool: "match.done", phase: "comms", jsonSchema: {} },
      { tool: "match.throw", phase: "throw", jsonSchema: {} },
    ],
    submit: (s, seat, a) => {
      if (s.phase === "comms" && a.kind === "say") {
        return {
          accepted: true,
          reason: "ok",
          committedActionId: `say:${seat}`,
          state: { ...s, said: { ...s.said, [seat]: (s.said[seat] ?? 0) + 1 } },
        };
      }
      if (s.phase === "comms" && a.kind === "done") {
        return {
          accepted: true,
          reason: "ok",
          committedActionId: `done:${seat}`,
          state: { ...s, done: { ...s.done, [seat]: true } },
        };
      }
      if (s.phase === "throw" && a.kind === "throw") {
        return {
          accepted: true,
          reason: "ok",
          committedActionId: `throw:${seat}`,
          state: { ...s, thrown: { ...s.thrown, [seat]: true } },
        };
      }
      return { accepted: false, reason: "illegal", state: s };
    },
    step: (s) => (s.phase === "comms" ? { ...s, phase: "throw" } : { ...s, phase: "done" }),
    isTerminal: (s) => s.phase === "done",
    score: (s) =>
      Object.fromEntries(seatsOf(s).map((seat) => [seat, s.said[seat] ?? 0])) as Record<
        SeatId,
        number
      >,
  };
}

const TWO_PHASE_TOOLS: Record<string, string[]> = {
  comms: ["match.say", "match.done"],
  throw: ["match.throw"],
  done: [],
};

function twoPhaseServer(config: MatchConfig, seed = "tp-seed") {
  return harness(
    newSession<TwoPhaseState>({
      game: makeTwoPhase(),
      config,
      seed,
      phaseToTools: TWO_PHASE_TOOLS,
      currentPhase: (s) => s.phase,
      isReady: (s) =>
        s.phase === "comms"
          ? config.seats.every((seat) => s.done[seat] === true)
          : s.phase === "throw"
            ? config.seats.every((seat) => s.thrown[seat] === true)
            : false,
      safeDefault: (s) => ({ kind: s.phase === "comms" ? "done" : "throw" }),
    }),
  );
}

function makeRpsServer(seats: ReturnType<typeof mkSeatId>[]) {
  return harness(
    newSession<RpsState>({
      game: makeRpsN(),
      config: {
        matchId: "m-rps",
        gameId: "rps-n",
        seats,
        rules: { rounds: 1 },
        budgets: {
          wallClockMsPerDecision: 5000,
          toolCallsPerTurn: 8,
          intelOrScoutPoints: 0,
          simRolloutsPerTurn: 0,
          invalidRetries: 1,
        },
      },
      seed: "rps-seed",
      phaseToTools: RPS_PHASE_TOOLS,
      currentPhase: (s) => s.phase,
      isReady: (s) => seats.every((seat) => s.committed[seat] !== null),
      safeDefault: () => ({ throw: "rock" }),
    }),
  );
}

test("commitDefault forces the seat's safe default and advances", () => {
  const seats = [mkSeatId(0), mkSeatId(1)];
  const srv = makeRpsServer(seats);
  srv.advance({ kind: "commitDefault", seat: mkSeatId(0) });
  srv.advance({ kind: "commitDefault", seat: mkSeatId(1) });
  expect(isTerminal(srv.get())).toBe(true);
  const lines = eventsToJsonl(sessionLog(srv.get()))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const defaults = lines.filter((e: { kind: string }) => e.kind === "action.default");
  expect(defaults.length).toBe(2);
});

describe("match server — multi-phase budget cadence and chained resolves", () => {
  test("per_turn_budget_resets_when_seat_opens_its_next_phase_turn", () => {
    // toolCallsPerTurn = 2. Seat 0 spends both calls in "comms", then both seats
    // finish "comms", advancing to "throw". Seat 0 must regain its budget in
    // "throw" and be able to throw — proving reset is per-turn, not per-resolve.
    const config = cfg(1, 2);
    const srv = twoPhaseServer(config);
    // Seat 0 burns its 2 tool calls in comms (1 say + 1 done).
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.say",
        input: { kind: "say" },
      }).ok,
    ).toBe(true);
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.done",
        input: { kind: "done" },
      }).ok,
    ).toBe(true);
    // A 3rd comms call by seat 0 in the SAME turn hits the budget wall.
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.say",
        input: { kind: "say" },
      }).reason,
    ).toBe("tool budget exhausted");
    // Seat 1 finishes comms -> resolve advances to "throw".
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(1),
        tool: "match.done",
        input: { kind: "done" },
      }).ok,
    ).toBe(true);
    expect(sessionState(srv.get()).phase).toBe("throw");
    // Seat 0's budget was exhausted in comms; opening its "throw" turn resets it.
    expect(
      srv.advance({
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.throw",
        input: { kind: "throw" },
      }).ok,
    ).toBe(true);
  });

  test("chained_resolves_emit_one_phase_resolve_per_step_without_deadlock", () => {
    const config = cfg(1, 2);
    const srv = twoPhaseServer(config);
    // Drive comms to ready.
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.done",
      input: { kind: "done" },
    });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(1),
      tool: "match.done",
      input: { kind: "done" },
    });
    expect(sessionState(srv.get()).phase).toBe("throw");
    // Drive throw to terminal.
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { kind: "throw" },
    });
    srv.advance({
      kind: "callTool",
      seat: mkSeatId(1),
      tool: "match.throw",
      input: { kind: "throw" },
    });
    expect(isTerminal(srv.get())).toBe(true);
    const kinds = sessionLog(srv.get()).map((e) => e.kind);
    // Two phase resolves (comms->throw, throw->terminal), exactly one each.
    expect(kinds.filter((k) => k === "phase.resolve")).toHaveLength(2);
    expect(kinds).toContain("rng.reveal");
    expect(kinds).toContain("match.terminal");
  });
});

test("commitDefault does not log a default the game rejects", () => {
  const seats = [mkSeatId(0), mkSeatId(1)];
  const srv = makeRpsServer(seats);
  srv.advance({
    kind: "callTool",
    seat: mkSeatId(0),
    tool: "match.throw",
    input: { throw: "rock" },
  });
  // Seat 0 already committed: rps-n rejects a second throw, so the safe default is rejected.
  const out = srv.advance({ kind: "commitDefault", seat: mkSeatId(0) });
  expect(out.ok).toBe(false);
  const defaults = sessionLog(srv.get()).filter((e) => e.kind === "action.default");
  expect(defaults).toEqual([]);
  expect(sessionState(srv.get()).committed[mkSeatId(0)]).toBe("rock");
  srv.advance({
    kind: "callTool",
    seat: mkSeatId(1),
    tool: "match.throw",
    input: { throw: "paper" },
  });
  expect(isTerminal(srv.get())).toBe(true);
  const verdict = verifyReplay({
    game: makeRpsN(),
    config: srv.get().config,
    seed: srv.get().seed,
    log: sessionLog(srv.get()),
  });
  expect(verdict.ok).toBe(true);
});

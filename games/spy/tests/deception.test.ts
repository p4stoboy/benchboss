import { describe, expect, test } from "bun:test";
import { type SeatId, createRng, mkSeatId } from "@benchboss/core";
import {
  type Command,
  type MatchHandle,
  type MatchSession,
  newSession,
  observe,
  sessionState,
  step,
} from "@benchboss/referee";
import { counterIntel, plantMisinfo, protectSource } from "../src/deception";
import { makeSpyGame } from "../src/game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import { dealRolesM3 } from "../src/roles";
import { assassinateSchema } from "../src/schemas";
import { spySenseResolvers } from "../src/sensing";
import type { SpyState } from "../src/types";
import { evaluateWin } from "../src/win";
import { handlerConfig } from "./helpers";

const mkRng = createRng;

const seats = [0, 1, 2, 3, 4].map(mkSeatId);

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

describe("M3 handler and deep cover", () => {
  test("deals_exactly_one_handler_and_one_deep_cover", () => {
    const deal = dealRolesM3(seats, createRng("m3-seed"));
    expect(deal.handlerSeat).not.toBeNull();
    expect(deal.deepCoverSeat).not.toBeNull();
    const handlerSeat = deal.handlerSeat;
    const deepCoverSeat = deal.deepCoverSeat;
    expect(handlerSeat).toBeDefined();
    expect(deepCoverSeat).toBeDefined();
    if (handlerSeat === null || handlerSeat === undefined) throw new Error("handlerSeat is null");
    if (deepCoverSeat === null || deepCoverSeat === undefined)
      throw new Error("deepCoverSeat is null");
    expect(deal.alignmentBySeat[handlerSeat]).toBe("loyal");
    expect(deal.alignmentBySeat[deepCoverSeat]).toBe("mole");
    expect(deal.roleBySeat[handlerSeat]).toBe("handler");
    expect(deal.roleBySeat[deepCoverSeat]).toBe("deepcover");
  });

  test("handler_known_moles_exclude_the_deep_cover", () => {
    const deal = dealRolesM3(seats, createRng("m3-seed"));
    const handlerView = deal.moleSeats.filter((s) => s !== deal.deepCoverSeat);
    expect(handlerView).not.toContain(deal.deepCoverSeat);
    expect(handlerView.length).toBe(deal.moleSeats.length - 1);
  });

  test("is_deterministic", () => {
    const a = dealRolesM3(seats, createRng("same"));
    const b = dealRolesM3(seats, createRng("same"));
    expect(a).toEqual(b);
  });

  test("handler_knowledge_does_not_leak_into_a_loyal_completed_envelope", () => {
    const game = makeSpyGame();
    const server = harness(
      newSession<SpyState>({
        game,
        config: handlerConfig(),
        seed: "m3-leak",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
      }),
    );
    const st = sessionState(server.get());
    const handler = st.deal.handlerSeat;
    const deepCover = st.deal.deepCoverSeat;
    expect(handler).not.toBeNull();
    expect(deepCover).not.toBeNull();
    if (handler === null || handler === undefined) throw new Error("handlerSeat is null");
    if (deepCover === null || deepCover === undefined) throw new Error("deepCoverSeat is null");

    const plainLoyal = st.seats.find(
      (s) => st.deal.alignmentBySeat[s] === "loyal" && s !== handler,
    );
    expect(plainLoyal).toBeDefined();
    if (plainLoyal === undefined) throw new Error("expected a plain loyal seat");

    // A plain Loyal's completed envelope knows NO moles and cannot name the handler.
    const loyalObs = observe(server.get(), plainLoyal) as {
      privateState: { knownMoles: SeatId[]; ownRole: string };
      legalTools: string[];
      budgets: Record<string, number>;
    };
    expect(loyalObs.privateState.knownMoles).toEqual([]);
    expect(Array.isArray(loyalObs.legalTools)).toBe(true);
    expect(typeof loyalObs.budgets.intelOrScoutPoints).toBe("number");
    const loyalSerialized = JSON.stringify(loyalObs);
    expect(loyalSerialized).not.toContain("handlerSeat");
    expect(loyalSerialized).not.toContain("deepCoverSeat");
    expect(loyalSerialized).not.toContain("alignmentBySeat");

    // The Handler sees the Moles MINUS the Deep Cover — Deep Cover looks clean.
    const handlerObs = observe(server.get(), handler) as {
      privateState: { knownMoles: SeatId[] };
    };
    expect(handlerObs.privateState.knownMoles).not.toContain(deepCover);
    expect(new Set(handlerObs.privateState.knownMoles)).toEqual(
      new Set(st.deal.moleSeats.filter((s) => s !== deepCover)),
    );
  });

  test("m3_deal_pins_concrete_handler_and_deep_cover_for_a_fixed_seed", () => {
    const deal = dealRolesM3(seats, createRng("m3-pin-seed"));
    expect(deal.handlerSeat).toBeDefined();
    expect(deal.deepCoverSeat).toBeDefined();
    const handlerSeat = deal.handlerSeat;
    const deepCoverSeat = deal.deepCoverSeat;
    if (handlerSeat === null || handlerSeat === undefined) throw new Error("handlerSeat is null");
    if (deepCoverSeat === null || deepCoverSeat === undefined)
      throw new Error("deepCoverSeat is null");
    expect(handlerSeat).toBe(mkSeatId(0));
    expect(deepCoverSeat).toBe(mkSeatId(3));
    expect(deal.alignmentBySeat[handlerSeat]).toBe("loyal");
    expect(deal.alignmentBySeat[deepCoverSeat]).toBe("mole");
    expect(deal.roleBySeat[handlerSeat]).toBe("handler");
    expect(deal.roleBySeat[deepCoverSeat]).toBe("deepcover");
  });

  test("assassin_observation_does_not_leak_handler_identity_pre_guess", () => {
    const game = makeSpyGame();
    const server = harness(
      newSession<SpyState>({
        game,
        config: handlerConfig(),
        seed: "m3-leak",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
      }),
    );
    const st = sessionState(server.get());
    const deepCover = st.deal.deepCoverSeat;
    expect(deepCover).not.toBeNull();
    if (deepCover === null || deepCover === undefined) throw new Error("deepCoverSeat is null");

    const mole = st.deal.moleSeats[0];
    expect(mole).toBeDefined();
    if (mole === undefined) throw new Error("expected a mole seat");

    const moleObs = observe(server.get(), mole);
    const moleSerialized = JSON.stringify(moleObs);
    // The Handler's identity must not be revealed to the mole before they guess.
    expect(moleSerialized).not.toContain("handlerSeat");
    expect(moleSerialized).not.toContain('"handler"');
  });

  test("mole_completed_envelope_does_not_leak_deal_internals", () => {
    const game = makeSpyGame();
    const server = harness(
      newSession<SpyState>({
        game,
        config: handlerConfig(),
        seed: "m3-leak",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
      }),
    );
    const st = sessionState(server.get());
    const deepCover = st.deal.deepCoverSeat;
    expect(deepCover).not.toBeNull();
    if (deepCover === null || deepCover === undefined) throw new Error("deepCoverSeat is null");

    // Pick a plain Mole (not the Deep Cover) for symmetric coverage.
    const plainMole = st.deal.moleSeats.find((s) => s !== deepCover);
    expect(plainMole).toBeDefined();
    if (plainMole === undefined) throw new Error("expected a plain mole seat");

    const moleObs = observe(server.get(), plainMole);
    const moleSerialized = JSON.stringify(moleObs);
    expect(moleSerialized).not.toContain("handlerSeat");
    expect(moleSerialized).not.toContain("deepCoverSeat");
    expect(moleSerialized).not.toContain("alignmentBySeat");
    expect(moleSerialized).not.toContain("roleBySeat");
    expect(moleSerialized).not.toContain("moleSeats");
  });
});

describe("deception tools", () => {
  test("plant_misinfo_flags_the_target", () => {
    let st = m3State({});
    const mole = st.deal.moleSeats[0];
    if (mole === undefined) throw new Error("expected a mole seat");
    st = plantMisinfo(st, mole);
    expect(st.misinfoFlags[mole]).toBe(true);
  });

  test("protect_source_is_idempotent", () => {
    let st = m3State({});
    const mole = st.deal.moleSeats[0];
    if (mole === undefined) throw new Error("expected a mole seat");
    st = protectSource(protectSource(st, mole), mole);
    expect(st.protectedSources).toEqual([mole]);
  });

  test("protection_is_consumed_by_the_next_sabotage_and_marks_it_untraceable", () => {
    const game = makeSpyGame();
    const base = m3State({});
    const mole = base.deal.moleSeats[0];
    const loyal = base.seats.find((s) => base.deal.alignmentBySeat[s] === "loyal");
    if (mole === undefined || loyal === undefined) throw new Error("expected both roles");
    const st: SpyState = {
      ...base,
      phase: "operation",
      proposal: { proposalId: "p", leader: loyal, team: [mole, loyal], opIndex: 0 },
      missionActions: [
        { seat: mole, sabotage: true },
        { seat: loyal, sabotage: false },
      ],
      protectedSources: [mole],
    };
    const next = game.step(st);
    expect(next.opResults[0]?.saboteurs).toEqual([mole]);
    expect(next.opResults[0]?.untraceable).toEqual([mole]);
    expect(next.protectedSources).toEqual([]);
  });

  test("protection_survives_an_op_the_protected_seat_did_not_sabotage", () => {
    const game = makeSpyGame();
    const base = m3State({});
    const mole = base.deal.moleSeats[0];
    const loyal = base.seats.find((s) => base.deal.alignmentBySeat[s] === "loyal");
    if (mole === undefined || loyal === undefined) throw new Error("expected both roles");
    const st: SpyState = {
      ...base,
      phase: "operation",
      proposal: { proposalId: "p", leader: loyal, team: [mole, loyal], opIndex: 0 },
      missionActions: [
        { seat: mole, sabotage: false },
        { seat: loyal, sabotage: false },
      ],
      protectedSources: [mole],
    };
    const next = game.step(st);
    expect(next.opResults[0]?.saboteurs).toEqual([]);
    expect(next.opResults[0]?.untraceable).toEqual([]);
    expect(next.protectedSources).toEqual([mole]);
  });

  test("counterintel_names_only_seats_that_scanned_the_caller_and_sometimes_misses_one", () => {
    const base = m3State({});
    const mole = base.deal.moleSeats[0];
    if (mole === undefined) throw new Error("expected a mole seat");
    const [a, b, c] = base.seats.filter((s) => s !== mole);
    if (a === undefined || b === undefined || c === undefined) throw new Error("seats");
    const scanOf = (seat: SeatId, target: SeatId) => ({
      actId: `intel:scan:${seat}`,
      seat,
      tool: "intel.scan_alignment",
      round: 0,
      payload: { target, signal: "loyal" },
    });
    const st: SpyState = {
      ...base,
      intelResults: { [a]: [scanOf(a, mole)], [b]: [scanOf(b, mole)], [c]: [scanOf(c, a)] },
    };
    const sizes = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = counterIntel(st, mole, mkRng(`ci${i}`));
      for (const s of r.scannedBy) expect([a, b]).toContain(s);
      sizes.add(r.scannedBy.length);
    }
    expect(sizes).toEqual(new Set([1, 2]));
  });

  test("deception_resolvers_spend_intelOrScoutPoints_not_toolCallsPerTurn", () => {
    const server = harness(
      newSession<SpyState>({
        game: makeSpyGame(),
        config: handlerConfig(),
        seed: "m3-dec-budget",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
        senseResolvers: spySenseResolvers("m3-dec-budget"),
      }),
    );

    // Advance to intel phase
    const seats: SeatId[] = sessionState(server.get()).seats;
    for (const s of seats)
      server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });

    const seat0 = seats[0];
    expect(seat0).toBeDefined();
    if (seat0 === undefined) throw new Error("expected seat 0");
    const token = seat0;

    // Warmup call to open the turn (triggers ledger.reset)
    const warmup = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.plant_misinfo",
      input: { target: seat0 },
    });
    expect(warmup.ok).toBe(true);
    const before = (warmup.observation as { budgets: Record<string, number> }).budgets;
    expect(before.intelOrScoutPoints).toBeDefined();
    expect(before.toolCallsPerTurn).toBeDefined();
    if (before.intelOrScoutPoints === undefined || before.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing");

    const r = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.counterintel",
      input: {},
    });
    expect(r.ok).toBe(true);
    const after = (observe(server.get(), token) as { budgets: Record<string, number> }).budgets;
    expect(after.intelOrScoutPoints).toBeDefined();
    expect(after.toolCallsPerTurn).toBeDefined();
    if (after.intelOrScoutPoints === undefined || after.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing after");

    expect(after.intelOrScoutPoints).toBe(before.intelOrScoutPoints - 1);
    expect(after.toolCallsPerTurn).toBe(before.toolCallsPerTurn); // sensing never spends tool calls
  });

  test("deception_effects_are_private_and_do_not_leak_to_other_seats", () => {
    const server = harness(
      newSession<SpyState>({
        game: makeSpyGame(),
        config: handlerConfig(),
        seed: "m3-dec-leak",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
        senseResolvers: spySenseResolvers("m3-dec-leak"),
      }),
    );

    const seats: SeatId[] = sessionState(server.get()).seats;
    for (const s of seats)
      server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });

    const moleSeats: SeatId[] = sessionState(server.get()).deal.moleSeats;
    const mole = moleSeats[0];
    expect(mole).toBeDefined();
    if (mole === undefined) throw new Error("expected a mole seat");
    const loyal = seats.find(
      (s: SeatId) => sessionState(server.get()).deal.alignmentBySeat[s] === "loyal",
    );
    expect(loyal).toBeDefined();
    if (loyal === undefined) throw new Error("expected a loyal seat");

    const moleToken = mole;
    const loyalToken = loyal;

    // Mole plants misinfo
    const r = server.advance({
      kind: "callTool",
      seat: moleToken,
      tool: "intel.plant_misinfo",
      input: { target: mole },
    });
    expect(r.ok).toBe(true);

    // The loyal seat's observation must not expose misinfoFlags or protectedSources
    const loyalObs = observe(server.get(), loyalToken);
    const serialized = JSON.stringify(loyalObs);
    expect(serialized).not.toContain("misinfoFlags");
    expect(serialized).not.toContain("protectedSources");

    // The loyal seat's ownIntel should not contain the mole's plant_misinfo result
    const loyalObsTyped = loyalObs as { privateState: { ownIntel: unknown[] } };
    expect(loyalObsTyped.privateState.ownIntel.length).toBe(0);
  });

  test("loyal_cannot_call_plant_misinfo_gets_mole_only_error_and_state_unchanged", () => {
    const server = harness(
      newSession<SpyState>({
        game: makeSpyGame(),
        config: handlerConfig(),
        seed: "m3-loyal-gate",
        phaseToTools: SPY_PHASE_TOOLS,
        currentPhase,
        isReady,
        safeDefault: spySafeDefault,
        senseResolvers: spySenseResolvers("m3-loyal-gate"),
      }),
    );

    const seats: SeatId[] = sessionState(server.get()).seats;
    for (const s of seats)
      server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });

    const stateBefore = sessionState(server.get());
    const loyal = stateBefore.seats.find(
      (s: SeatId) => stateBefore.deal.alignmentBySeat[s] === "loyal",
    );
    expect(loyal).toBeDefined();
    if (loyal === undefined) throw new Error("expected a loyal seat");

    const loyalToken = loyal;
    const result = server.advance({
      kind: "callTool",
      seat: loyalToken,
      tool: "intel.plant_misinfo",
      input: { target: loyal },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not legal for seat");
    expect(result.result).toBeUndefined();

    // misinfoFlags must be unchanged — no flag was written
    const stateAfter = sessionState(server.get());
    expect(stateAfter.misinfoFlags[loyal]).toBeUndefined();
    expect(stateAfter.misinfoFlags).toEqual(stateBefore.misinfoFlags);
  });
});

function m3State(over: Partial<SpyState>): SpyState {
  const game = makeSpyGame();
  const base = game.newMatch(
    {
      matchId: "m",
      gameId: "safehouse-protocol",
      seats: [0, 1, 2, 3, 4].map(mkSeatId),
      rules: { rounds: 5, handler: true },
      budgets: {
        wallClockMsPerDecision: 1,
        toolCallsPerTurn: 8,
        intelOrScoutPoints: 3,
        simRolloutsPerTurn: 0,
        invalidRetries: 2,
      },
    },
    "assassin-seed",
  );
  return { ...base, ...over };
}

describe("M3 assassin endgame", () => {
  test("three_successes_with_a_handler_enters_assassinate_not_loyal_win", () => {
    const st = m3State({ successes: 3 });
    const r = evaluateWin(st);
    expect(r.over).toBe(false); // pending assassin guess
  });

  test("correct_handler_guess_flips_to_mole_win", () => {
    let st = m3State({ successes: 3, phase: "assassinate" });
    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");
    expect(st.deal.handlerSeat).not.toBeNull();
    if (st.deal.handlerSeat === null) throw new Error("handlerSeat is null");
    st = makeSpyGame().submit(st, assassin, {
      target: st.deal.handlerSeat,
    }).state;
    st = makeSpyGame().step(st);
    expect(st.winner).toBe("mole");
    expect(st.winReason).toBe("assassin");
  });

  test("wrong_handler_guess_confirms_loyal_win", () => {
    let st = m3State({ successes: 3, phase: "assassinate" });
    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");
    const wrong = st.seats.find(
      (s) => s !== st.deal.handlerSeat && st.deal.alignmentBySeat[s] === "loyal",
    );
    expect(wrong).toBeDefined();
    if (wrong === undefined) throw new Error("expected a wrong loyal seat");
    st = makeSpyGame().submit(st, assassin, {
      target: wrong,
    }).state;
    st = makeSpyGame().step(st);
    expect(st.winner).toBe("loyal");
  });

  test("m2_no_handler_wins_immediately_on_three_successes", () => {
    const game = makeSpyGame();
    const base = game.newMatch(
      {
        matchId: "m2",
        gameId: "safehouse-protocol",
        seats: [0, 1, 2, 3, 4].map(mkSeatId),
        rules: { rounds: 5 },
        budgets: {
          wallClockMsPerDecision: 1,
          toolCallsPerTurn: 8,
          intelOrScoutPoints: 3,
          simRolloutsPerTurn: 0,
          invalidRetries: 2,
        },
      },
      "m2-seed",
    );
    const st = { ...base, successes: 3 };
    const r = evaluateWin(st);
    expect(r.over).toBe(true);
    expect(r.winner).toBe("loyal");
  });

  test("assassin_guess_does_not_leak_handler_identity_pre_guess", () => {
    const st = m3State({ successes: 3, phase: "assassinate" });
    // assassinGuess must be null at this point — the Handler is not yet revealed
    expect(st.assassinGuess).toBeNull();
    // The Handler seat is only resolvable post-guess in evaluateWin; not pre-announced
    const win = evaluateWin(st);
    expect(win.over).toBe(false);
    expect(win.winner).toBeNull();
  });

  test("observe_in_assassinate_phase_does_not_leak_handler_seat_to_assassin", () => {
    // Verify the highest-risk pre-guess moment: the assassin's observation while
    // phase === "assassinate" must not expose handlerSeat, deepCoverSeat, or alignmentBySeat.
    const game = makeSpyGame();
    const st = m3State({ successes: 3, phase: "assassinate" });

    const handler = st.deal.handlerSeat;
    expect(handler).not.toBeNull();
    if (handler === null || handler === undefined) throw new Error("handlerSeat is null");

    // Pick a Mole seat (the assassin) — any Mole works.
    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");

    const obs = game.observe(st, assassin);
    const serialized = JSON.stringify(obs);

    // The handler's identity must not appear in the observation.
    expect(serialized).not.toContain("handlerSeat");
    expect(serialized).not.toContain("alignmentBySeat");
    expect(serialized).not.toContain("deepCoverSeat");
    // The literal handler seat value must not appear as a top-level disclosed seat.
    expect(obs.privateState.knownMoles).not.toContain(handler);
  });

  test("assassinate_safe_default_passes_schema_and_resolves_to_loyal_win", () => {
    // Verify Fix 1: spySafeDefault("assassinate") is schema-valid (no deadlock),
    // and submitting it produces a Loyal win (wrong guess — penalizes inaction).
    const game = makeSpyGame();
    let st = m3State({ successes: 3, phase: "assassinate" });

    const handler = st.deal.handlerSeat;
    expect(handler).not.toBeNull();
    if (handler === null || handler === undefined) throw new Error("handlerSeat is null");

    const assassin = st.deal.moleSeats[0];
    expect(assassin).toBeDefined();
    if (assassin === undefined) throw new Error("expected a mole seat");

    const safeAction = spySafeDefault(st, assassin);

    // Must pass the schema — no deadlock on timeout.
    expect(() => assassinateSchema.parse(safeAction)).not.toThrow();
    const parsed = assassinateSchema.parse(safeAction);

    // Must NOT target the handler — a timed-out assassin should not reward the Moles.
    expect(parsed.target).not.toBe(handler);

    // Submitting the safe default resolves the phase.
    const submitResult = game.submit(st, assassin, { target: parsed.target });
    expect(submitResult.accepted).toBe(true);
    st = submitResult.state;

    // Stepping resolves to a Loyal win (wrong guess).
    st = game.step(st);
    expect(st.winner).toBe("loyal");
  });
});

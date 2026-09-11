import { describe, expect, test } from "bun:test";
import { appendEvent, mkSeatId, sha256Commit, verifyReplay } from "../src/index";
import type { GameModule, LogEvent, MatchConfig, SeatId } from "../src/index";

type CState = {
  count: number;
  phase: string;
  resolved: number;
  cfg: MatchConfig;
};

const counterGame: GameModule<CState, { add: number }, unknown, number> = {
  id: "counter",
  newMatch: (cfg) => ({ count: 0, phase: "add", resolved: 0, cfg }),
  observe: (s) => ({ count: s.count }),
  legalActions: () => [{ tool: "match.add", phase: "add", jsonSchema: {} }],
  submit: (s, _seat, a) => ({
    accepted: true,
    reason: "ok",
    committedActionId: `c${s.count}`,
    state: { ...s, count: s.count + a.add },
  }),
  step: (s) => ({ ...s, resolved: s.resolved + 1 }),
  isTerminal: (s) => s.resolved >= 1,
  score: (s) => ({ [mkSeatId(0)]: s.count }) as Record<SeatId, number>,
};

const cfg: MatchConfig = {
  matchId: "m1",
  gameId: "counter",
  seats: [mkSeatId(0)],
  rules: {},
  budgets: {
    wallClockMsPerDecision: 1,
    toolCallsPerTurn: 1,
    intelOrScoutPoints: 0,
    simRolloutsPerTurn: 0,
    invalidRetries: 0,
  },
};

function goodLog(): LogEvent[] {
  let events: readonly LogEvent[] = [];
  events = appendEvent(events, {
    matchId: "m1",
    phase: "add",
    seat: mkSeatId(0),
    kind: "action.submit",
    payload: { action: { add: 5 } },
  });
  events = appendEvent(events, {
    matchId: "m1",
    phase: "add",
    seat: mkSeatId(0),
    kind: "action.submit",
    payload: { action: { add: 2 } },
  });
  events = appendEvent(events, {
    matchId: "m1",
    phase: "add",
    seat: null,
    kind: "phase.resolve",
    payload: {},
  });
  events = appendEvent(events, {
    matchId: "m1",
    phase: "add",
    seat: null,
    kind: "match.terminal",
    payload: { score: { "seat:0": 7 } },
  });
  return [...events];
}

describe("replay verifier", () => {
  test("verifies_terminal_score_for_clean_legacy_log_without_rng_markers", () => {
    const res = verifyReplay({
      game: counterGame,
      config: cfg,
      seed: "s",
      log: goodLog(),
    });
    expect(res.ok).toBe(true);
    expect(res.divergenceSeq).toBeUndefined();
  });

  test("rejects_every_truncated_prefix_and_nonfinal_or_duplicate_terminal", () => {
    const clean = goodLog();
    for (let length = 0; length < clean.length; length++) {
      expect(
        verifyReplay({ game: counterGame, config: cfg, seed: "s", log: clean.slice(0, length) }).ok,
      ).toBe(false);
    }
    const terminal = clean.at(-1) as LogEvent;
    for (const kind of ["match.terminal", "sense.serve"]) {
      expect(
        verifyReplay({
          game: counterGame,
          config: cfg,
          seed: "s",
          log: [...clean, { ...terminal, seq: clean.length, kind }],
        }).ok,
      ).toBe(false);
    }
  });

  test("rejects_wrong_match_identity_noncontiguous_sequence_and_unknown_action_seat", () => {
    for (const mutation of [{ matchId: "another-match" }, { seq: 7 }, { seat: mkSeatId(99) }]) {
      const log = goodLog();
      log[1] = { ...(log[1] as LogEvent), ...mutation };
      const result = verifyReplay({ game: counterGame, config: cfg, seed: "s", log });
      expect(result.ok).toBe(false);
      expect(result.divergenceSeq).toBe(1);
    }
  });

  test("validates_every_present_seed_marker_against_the_supplied_seed", () => {
    const clean = goodLog();
    const template = clean[0] as LogEvent;
    const log = [
      { ...template, seat: null, kind: "rng.commit", payload: { hash: sha256Commit("s") } },
      ...clean.slice(0, -1),
      { ...template, seat: null, kind: "rng.reveal", payload: { seed: "s" } },
      clean.at(-1) as LogEvent,
    ].map((event, seq) => ({ ...event, seq }));
    expect(verifyReplay({ game: counterGame, config: cfg, seed: "s", log }).ok).toBe(true);
    expect(verifyReplay({ game: counterGame, config: cfg, seed: "other", log }).ok).toBe(false);
    for (const kind of ["rng.commit", "rng.reveal"]) {
      const corrupt = log.map((event) =>
        event.kind === kind ? { ...event, payload: { hash: "wrong", seed: "wrong" } } : event,
      );
      expect(verifyReplay({ game: counterGame, config: cfg, seed: "s", log: corrupt }).ok).toBe(
        false,
      );
    }
  });

  test("compares_all_recorded_configuration_fields_independent_of_object_key_order", () => {
    const withConfig = (config: unknown) =>
      goodLog().map((event) =>
        event.kind === "match.terminal"
          ? { ...event, payload: { ...event.payload, config } }
          : event,
      );
    const reordered = Object.fromEntries(Object.entries(cfg).reverse());
    expect(
      verifyReplay({ game: counterGame, config: cfg, seed: "s", log: withConfig(reordered) }).ok,
    ).toBe(true);
    for (const config of [
      { ...cfg, gameId: "other-game" },
      { ...cfg, matchId: "other-match" },
      { ...cfg, seats: [mkSeatId(1)] },
      { ...cfg, budgets: { ...cfg.budgets, toolCallsPerTurn: 99 } },
      { ...cfg, rules: { extra: true } },
      {
        ...cfg,
        identity: {
          protocolVersion: 1,
          runtimeVersion: "other",
          gameId: "counter",
          revision: "other",
        },
      },
      null,
    ]) {
      expect(
        verifyReplay({ game: counterGame, config: cfg, seed: "s", log: withConfig(config) }).ok,
      ).toBe(false);
    }
  });

  test("converts_malformed_action_game_exceptions_into_verification_failures", () => {
    const log = goodLog();
    log[1] = { ...(log[1] as LogEvent), payload: { action: null } };
    const result = verifyReplay({ game: counterGame, config: cfg, seed: "s", log });
    expect(result.ok).toBe(false);
    expect(result.divergenceSeq).toBe(1);
    expect(result.detail).toContain("game execution failure");
  });

  test("reports_divergence_seq_for_corrupted_action_payload", () => {
    const log = goodLog();
    // Corrupt the second submit so replayed score becomes 5+9=14, not 7.
    const entry1 = log[1] as LogEvent;
    log[1] = { ...entry1, payload: { action: { add: 9 } } };
    const res = verifyReplay({ game: counterGame, config: cfg, seed: "s", log });
    expect(res.ok).toBe(false);
    expect(res.divergenceSeq).toBe(3);
  });

  test("reports_divergence_when_terminal_score_marker_mismatches", () => {
    const log = goodLog();
    const entry3 = log[3] as LogEvent;
    log[3] = { ...entry3, payload: { score: { "seat:0": 99 } } };
    const res = verifyReplay({ game: counterGame, config: cfg, seed: "s", log });
    expect(res.ok).toBe(false);
    expect(res.divergenceSeq).toBe(3);
  });
});

describe("replay version boundary", () => {
  test("refuses v2 configuration whose time and host events require exact referee replay", () => {
    const config = {
      matchId: cfg.matchId,
      gameId: cfg.gameId,
      seats: cfg.seats,
      rules: cfg.rules,
      identity: {
        protocolVersion: 2 as const,
        runtimeVersion: "0.2.0",
        gameId: cfg.gameId,
        revision: "2.0.0",
      },
      timing: {
        playerTotalMs: 1000,
        decisionLimitMs: null,
        phaseLimits: {},
        clockVisibility: "private" as const,
      },
      resources: {},
      metering: {},
    };
    const result = verifyReplay({ game: counterGame, config, seed: "s", log: goodLog() });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("verifyPluginReplay");
  });
});

test("legacy replay refuses v2 accounting events even when configuration was downgraded", () => {
  for (const kind of [
    "command",
    "command.result",
    "clock.advance",
    "clock.state",
    "host.event",
    "resource.spend",
    "phase.begin",
  ]) {
    const clean = goodLog();
    const template = clean[0];
    if (!template) throw Error("missing fixture event");
    const log = [{ ...template, kind, payload: {} }, ...clean].map((event, seq) => ({
      ...event,
      seq,
    }));
    const result = verifyReplay({ game: counterGame, config: cfg, seed: "s", log });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("verifyPluginReplay");
  }
});

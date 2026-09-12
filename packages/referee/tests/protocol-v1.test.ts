import { describe, expect, test } from "bun:test";
import { type MatchConfig, type SeatId, mkSeatId } from "@benchboss/core";
import type { HostEvent, Participation, TimingPolicy } from "@benchboss/protocol";
import type { GamePlugin } from "../src/game-plugin";
import {
  clockSnapshot,
  newSession,
  observe,
  participation,
  phaseId,
  publicView,
  step,
} from "../src/match-server";
import { verifyPluginReplay } from "../src/replay-verifier";

const seats: [SeatId, SeatId] = [mkSeatId(0), mkSeatId(1)];
interface State {
  phase: string;
  turns: number;
  seats: SeatId[];
  active: SeatId[];
  done: SeatId[];
  events: HostEvent[];
  sensed: number;
  rounds: number;
}
function fixture(
  options: {
    timing?: Partial<TimingPolicy>;
    simultaneous?: boolean;
    noActions?: boolean;
    noExhaustionProgress?: boolean;
    ready?: boolean;
    repeatPhases?: boolean;
    actionCost?: number;
    actionReset?: "match" | "phase" | "decision";
    explicitWaiting?: boolean;
    senseCost?: number;
    senseResource?: string;
    exhaustionKeepsMatch?: boolean;
    allowNoise?: boolean;
    directPhases?: boolean;
  } = {},
) {
  const timing: TimingPolicy = {
    playerTotalMs: 100,
    decisionLimitMs: null,
    phaseLimits: {},
    clockVisibility: "private",
    ...options.timing,
  };
  const plugin: GamePlugin<State> = {
    id: "clock-fixture",
    defaultSeats: 2,
    manifest: {
      protocolVersion: 1,
      id: "clock-fixture",
      revision: "1.0.0",
      title: "Clock fixture",
      description: "Fixture",
      rulesSource: "test",
      seatCounts: [2],
      defaultSeats: 2,
      rulesSchema: {},
      defaultRules: {},
      defaultTiming: timing,
      defaultResources: {
        scans: { amount: 2, reset: "match", visibility: "private" },
        calls: { amount: 1, reset: options.actionReset ?? "decision", visibility: "public" },
        retries: { amount: 1, reset: "match", visibility: "private" },
      },
      defaultMetering: {
        action: { resource: "calls", cost: options.actionCost ?? 1 },
        invalidAction: { resource: "retries", cost: 1 },
      },
      roundStructure: [],
      winConditions: [],
      safeDefaults: [],
      disclosure: "full-after-terminal",
    },
    publicView: (s) => ({
      version: 1,
      progress: { phase: s.phase, label: "Fixture", current: s.turns, total: null },
      blocks: [],
      result:
        s.phase === "terminal"
          ? {
              summary: "finished",
              seats: seats.map((seat) => ({ seat, outcome: "draw", placement: 1, metrics: [] })),
            }
          : null,
    }),
    makeGame: () => ({
      id: "clock-fixture",
      newMatch: () => ({
        phase: "play",
        turns: 0,
        seats,
        active: options.noActions ? [] : options.simultaneous ? seats : [seats[0]],
        done: [],
        events: [],
        sensed: 0,
        rounds: 0,
      }),
      observe: (s, seat) => ({
        matchId: "timing",
        phase: s.phase,
        seat,
        publicState: {},
        privateState: {},
      }),
      legalActions: (s, seat) =>
        s.active.includes(seat) && s.phase !== "terminal"
          ? [
              {
                tool: "match.act",
                phase: s.phase,
                jsonSchema: {
                  type: "object",
                  properties: {
                    reject: { type: "boolean" },
                    ...(options.allowNoise ? { noise: { type: "string" } } : {}),
                  },
                  additionalProperties: false,
                },
              },
              {
                tool: "match.scan",
                phase: s.phase,
                jsonSchema: { type: "object", additionalProperties: false },
              },
            ]
          : [],
      submit: (s, seat, input) =>
        input.reject
          ? { accepted: false, reason: "rejected", state: s }
          : {
              accepted: true,
              reason: "ok",
              state: {
                ...s,
                turns: s.turns + 1,
                phase: options.directPhases ? (s.phase === "play" ? "next" : "terminal") : s.phase,
                active: options.simultaneous
                  ? s.active.filter((x) => x !== seat)
                  : [seats.find((x) => x !== seat) ?? seats[0]],
              },
            },
      step: (s) => ({
        ...s,
        rounds: s.rounds + 1,
        phase: options.repeatPhases && s.rounds < 2 ? "play" : "terminal",
      }),
      isTerminal: (s) => s.phase === "terminal",
      score: () => Object.fromEntries(seats.map((seat) => [seat, 0])),
    }),
    phaseToTools: {
      play: ["match.act", "match.scan"],
      next: ["match.act", "match.scan"],
      terminal: [],
    },
    currentPhase: (s) => s.phase,
    isReady: () => options.ready ?? false,
    safeDefault: () => ({ tool: "match.act", input: {} }),
    participation: (s, seat): Participation =>
      s.done.includes(seat)
        ? { status: "finished", reason: "exhausted" }
        : { status: s.active.includes(seat) && !options.explicitWaiting ? "acting" : "waiting" },
    onHostEvent: (s, event) =>
      event.kind === "player_time_exhausted"
        ? options.noExhaustionProgress
          ? s
          : {
              ...s,
              phase: options.exhaustionKeepsMatch ? s.phase : "terminal",
              done: [...s.done, ...(event.seats as SeatId[])],
              events: [...s.events, event],
            }
        : s,
    senseResolvers: () => [
      {
        tool: "match.scan",
        resource: options.senseResource ?? "scans",
        cost: () => options.senseCost ?? 1,
        resolve: (s) => ({
          result: { count: s.sensed + 1 },
          nextState: { ...s, sensed: s.sensed + 1 },
        }),
      },
    ],
  };
  const config: MatchConfig = {
    matchId: "timing",
    gameId: plugin.id,
    identity: { protocolVersion: 1, runtimeVersion: "0.1.0", gameId: plugin.id, revision: "1.0.0" },
    seats,
    rules: {},
    timing,
    resources: plugin.manifest.defaultResources,
    metering: plugin.manifest.defaultMetering,
  };
  const session = newSession({
    game: plugin.makeGame(),
    config,
    seed: "clock",
    publicView: plugin.publicView,
    phaseToTools: plugin.phaseToTools,
    currentPhase: plugin.currentPhase,
    isReady: plugin.isReady,
    defaultAction: plugin.safeDefault,
    participation: plugin.participation,
    onHostEvent: plugin.onHostEvent,
    senseResolvers: plugin.senseResolvers?.("clock"),
  });
  return { session, plugin, config };
}
const time = <S>(session: Parameters<typeof step<S>>[0], at: number) =>
  step(session, { kind: "advanceTime", at }).session;
const act = <S>(session: Parameters<typeof step<S>>[0], seat = seats[0], input: unknown = {}) =>
  step(session, { kind: "callTool", seat, tool: "match.act", input }).session;

describe("protocol v1 referee", () => {
  test("total time survives actions and only active seats spend elapsed time", () => {
    let { session } = fixture();
    session = time(session, 1000);
    session = act(time(session, 1040));
    expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(60);
    expect(clockSnapshot(session, seats[1])?.remainingMs).toBe(100);
    session = act(time(session, 1070), seats[1]);
    session = time(session, 1129);
    expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(1);
    session = time(session, 1130);
    expect(session.state.phase).toBe("terminal");
    expect(session.state.events[0]?.kind).toBe("player_time_exhausted");
    expect(session.state.turns).toBe(2);
  });
  test("simultaneous exhaustion is one sorted atomic event and precedes phase or decision expiry", () => {
    let { session } = fixture({
      simultaneous: true,
      timing: {
        decisionLimitMs: 100,
        phaseLimits: { play: { durationMs: 100, close: "deadline" } },
      },
    });
    session = time(time(session, 0), 100);
    expect(session.state.events).toHaveLength(1);
    expect(session.state.events[0]).toMatchObject({ kind: "player_time_exhausted", seats });
    expect(session.log.at(-1)?.kind).toBe("match.terminal");
    expect(clockSnapshot(session, seats[0])?.running).toBe(false);
  });
  test("phase cutoffs do not renew after actions and zero-action phases expire", () => {
    let { session } = fixture({
      timing: { playerTotalMs: null, phaseLimits: { play: { durationMs: 50, close: "deadline" } } },
    });
    session = time(session, 100);
    const id = phaseId(session);
    session = act(time(session, 120));
    expect(phaseId(session)).toBe(id);
    expect(clockSnapshot(session, seats[1])?.phaseDeadline).toBe(150);
    session = time(session, 150);
    expect(session.state.phase).toBe("terminal");
    let empty = fixture({
      noActions: true,
      timing: { playerTotalMs: null, phaseLimits: { play: { durationMs: 50, close: "deadline" } } },
    }).session;
    empty = time(time(empty, 200), 250);
    expect(empty.state.phase).toBe("terminal");
  });
  test("sensing spends a named allowance without resetting cumulative time and complete replay rejects tampering", () => {
    const data = fixture();
    let session = time(data.session, 0);
    session = time(session, 20);
    session = step(session, {
      kind: "callTool",
      seat: seats[0],
      tool: "match.scan",
      input: {},
    }).session;
    expect(session.resources[seats[0]]?.scans).toBe(1);
    expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(80);
    session = time(session, 100);
    const args = { plugin: data.plugin, config: data.config, seed: "clock", log: session.log };
    expect(verifyPluginReplay(args)).toEqual({ ok: true });
    expect(
      verifyPluginReplay({
        ...args,
        plugin: { ...data.plugin, manifest: { ...data.plugin.manifest, revision: "unknown" } },
      }),
    ).toEqual({ ok: false, detail: "plugin identity mismatch" });
    for (const kind of [
      "command",
      "resource.spend",
      "sense.serve",
      "clock.advance",
      "match.terminal",
    ]) {
      const log = structuredClone(session.log);
      const event = log.find((e) => e.kind === kind);
      expect(event).toBeDefined();
      if (event) event.payload.tampered = true;
      expect(verifyPluginReplay({ ...args, log }).ok).toBe(false);
    }
  });
  test("broken total-exhaustion handlers abort rather than spinning defaults", () => {
    let { session } = fixture({ noExhaustionProgress: true });
    session = time(session, 0);
    expect(() => time(session, 100)).toThrow("exhausted seat must finish");
  });
  test("finished participation is permanent and cannot recover action offers", () => {
    const data = fixture();
    let session = time(data.session, 0);
    session = { ...session, state: { ...session.state, done: [seats[0]] } };
    session = time(session, 1);
    session = { ...session, state: { ...session.state, done: [] } };
    session = time(session, 2);
    expect(participation(session, seats[0]).status).toBe("finished");
    expect(
      step(session, { kind: "callTool", seat: seats[0], tool: "match.act", input: {} }).output.ok,
    ).toBe(false);
  });
});

describe("protocol v1 timing and accounting boundaries", () => {
  test("rejections and sensing retain the original decision deadline, with expiry winning equality", () => {
    let { session } = fixture({ actionCost: 0, timing: { decisionLimitMs: 50 } });
    session = time(session, 1000);
    session = time(session, 1020);
    session = step(session, {
      kind: "callTool",
      seat: seats[0],
      tool: "match.scan",
      input: {},
    }).session;
    const before = structuredClone(session.resources);
    session = step(session, {
      kind: "callTool",
      seat: seats[0],
      tool: "unknown",
      input: {},
    }).session;
    session = act(session, seats[0], { extra: true });
    expect(session.resources).toEqual(before);
    session = act(session, seats[0], { reject: true });
    expect(session.resources[seats[0]]?.retries).toBe(0);
    expect(clockSnapshot(session, seats[0])?.deadline).toBe(1050);
    session = time(session, 1050);
    expect(session.log.filter((e) => e.kind === "host.event").map((e) => e.payload.kind)).toEqual([
      "decision_expired",
    ]);
    expect(session.state.turns).toBe(1);
    expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(50);
    expect(
      step(session, { kind: "callTool", seat: seats[0], tool: "match.act", input: {} }).output.ok,
    ).toBe(false);
  });
  test("semantic retry exhaustion defaults exactly once without renewing player total", () => {
    let { session } = fixture({ actionCost: 0 });
    session = time(time(session, 0), 35);
    session = act(session, seats[0], { reject: true });
    session = act(session, seats[0], { reject: true });
    expect(session.state.turns).toBe(1);
    expect(session.log.filter((e) => e.kind === "action.default")).toHaveLength(1);
    expect(session.log.filter((e) => e.kind === "host.event").map((e) => e.payload.kind)).toEqual([
      "invalid_retries_exhausted",
    ]);
    expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(65);
  });
  test("deadline-only readiness waits while ready-or-deadline can finish immediately", () => {
    let delayed = fixture({
      noActions: true,
      ready: true,
      timing: { playerTotalMs: null, phaseLimits: { play: { durationMs: 50, close: "deadline" } } },
    }).session;
    delayed = time(delayed, 100);
    expect(delayed.state.phase).toBe("play");
    delayed = time(delayed, 149);
    expect(delayed.state.phase).toBe("play");
    expect(time(delayed, 150).state.phase).toBe("terminal");
    const early = fixture({
      noActions: true,
      ready: true,
      timing: {
        playerTotalMs: null,
        phaseLimits: { play: { durationMs: 50, close: "ready_or_deadline" } },
      },
    }).session;
    expect(time(early, 100).state.phase).toBe("terminal");
  });
  test("phase expiry precedes coincident decision expiry and applies the whole pending batch", () => {
    let { session } = fixture({
      simultaneous: true,
      timing: {
        playerTotalMs: null,
        decisionLimitMs: 50,
        phaseLimits: { play: { durationMs: 50, close: "deadline" } },
      },
    });
    session = time(time(session, 0), 50);
    expect(session.log.filter((e) => e.kind === "host.event").map((e) => e.payload.kind)).toEqual([
      "phase_expired",
    ]);
    expect(session.log.filter((e) => e.kind === "action.default").map((e) => e.seat)).toEqual(
      seats,
    );
    expect(session.state.turns).toBe(2);
  });
  test("repeated phase names get new identities and phase allowances while match resources persist", () => {
    let { session } = fixture({
      repeatPhases: true,
      actionReset: "phase",
      timing: { playerTotalMs: null, phaseLimits: { play: { durationMs: 50, close: "deadline" } } },
    });
    session = time(session, 0);
    session = step(session, {
      kind: "callTool",
      seat: seats[0],
      tool: "match.scan",
      input: {},
    }).session;
    session = act(session);
    const firstPhase = phaseId(session);
    expect(session.resources[seats[0]]?.calls).toBe(0);
    session = time(session, 50);
    expect(phaseId(session)).not.toBe(firstPhase);
    expect(session.state.phase).toBe("play");
    expect(clockSnapshot(session, seats[0])?.phaseDeadline).toBe(100);
    expect(session.resources[seats[0]]?.calls).toBe(1);
    expect(session.resources[seats[0]]?.scans).toBe(1);
    expect(time(session, 150).state.phase).toBe("terminal");
  });
  test("public projections cannot expose private clocks, allowances or sensing answers", () => {
    let { session } = fixture();
    session = time(time(session, 0), 20);
    session = step(session, {
      kind: "callTool",
      seat: seats[0],
      tool: "match.scan",
      input: {},
    }).session;
    const view = publicView(session);
    expect(view.clocks).toBeUndefined();
    expect(view.resources).toEqual(Object.fromEntries(seats.map((seat) => [seat, { calls: 1 }])));
    const own = observe(session, seats[0]) as {
      resources: Record<string, number>;
      clock: { remainingMs: number };
    };
    expect(own.resources.scans).toBe(1);
    expect(own.clock.remainingMs).toBe(80);
    expect(session.log.find((e) => e.kind === "sense.serve")?.payload).toEqual({
      tool: "match.scan",
      resource: "scans",
      cost: 1,
    });
    expect(
      session.log
        .filter((e) => e.kind === "command.result")
        .every((e) => !Object.hasOwn(e.payload, "result")),
    ).toBe(true);
  });
  test("elapsed time is conserved across varied alternating schedules", () => {
    for (let seed = 1; seed <= 16; seed++) {
      let { session } = fixture({ timing: { playerTotalMs: 10000 } });
      let now = 700;
      const spent = [0, 0];
      session = time(session, now);
      for (let turn = 0; turn < 20; turn++) {
        const actor = turn % 2;
        const elapsed = ((seed * (turn + 7)) % 29) + 1;
        now += elapsed;
        spent[actor] = (spent[actor] ?? 0) + elapsed;
        session = act(time(session, now), seats[actor]);
        expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(10000 - (spent[0] ?? 0));
        expect(clockSnapshot(session, seats[1])?.remainingMs).toBe(10000 - (spent[1] ?? 0));
      }
    }
  });
  test("backward and fractional time commands are rejected without modifying execution", () => {
    let { session } = fixture();
    session = time(session, 100);
    for (const at of [99, 100.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = step(session, { kind: "advanceTime", at });
      expect(result.output.ok).toBe(false);
      expect(result.session).toBe(session);
    }
  });
});

test("explicit waiting participation prevents game actions while keeping sensing available", () => {
  let { session } = fixture({ explicitWaiting: true });
  session = time(time(session, 0), 200);
  const observation = observe(session, seats[0]) as { legalTools: string[] };
  expect(observation.legalTools).toEqual(["match.scan"]);
  expect(
    step(session, { kind: "callTool", seat: seats[0], tool: "match.act", input: {} }).output.ok,
  ).toBe(false);
  expect(step(session, { kind: "commitDefault", seat: seats[0] }).output.ok).toBe(false);
  expect(
    step(session, { kind: "callTool", seat: seats[0], tool: "match.scan", input: {} }).output.ok,
  ).toBe(true);
  expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(100);
});

test("an exhausted finished seat stops spending while the rest of the match can continue", () => {
  let { session } = fixture({ exhaustionKeepsMatch: true });
  session = time(time(session, 0), 100);
  expect(session.state.phase).toBe("play");
  expect(participation(session, seats[0]).status).toBe("finished");
  session = time(session, 1000);
  expect(clockSnapshot(session, seats[0])?.remainingMs).toBe(0);
  expect(clockSnapshot(session, seats[1])?.remainingMs).toBe(100);
  expect((observe(session, seats[0]) as { legalTools: string[] }).legalTools).toEqual([]);
});

test("negative, nonfinite and undeclared sensing charges cannot mint resources", () => {
  for (const options of [
    { senseCost: -1 },
    { senseCost: 0.5 },
    { senseCost: Number.NaN },
    { senseCost: Number.POSITIVE_INFINITY },
    { senseResource: "undeclared" },
    { senseResource: "__proto__" },
  ]) {
    const { session } = fixture(options);
    const before = structuredClone(session.resources);
    expect(() =>
      step(session, { kind: "callTool", seat: seats[0], tool: "match.scan", input: {} }),
    ).toThrow("invalid resource charge");
    expect(session.resources).toEqual(before);
  }
});

describe("replay artifact denial-of-service boundaries", () => {
  test("oversized unknown and schema-invalid calls leave no commands or frames before a valid terminal replay", () => {
    const data = fixture();
    let session = time(data.session, 0);
    const before = session;
    const noise = "x".repeat(60000);
    for (let attempt = 0; attempt < 150; attempt++) {
      for (const tool of ["unknown", "match.act"]) {
        const result = step(session, { kind: "callTool", seat: seats[0], tool, input: { noise } });
        expect(result.output.ok).toBe(false);
        session = result.session;
      }
    }
    expect(session === before).toBe(true);
    expect(session.log === before.log).toBe(true);
    expect(session.frames === before.frames).toBe(true);
    session = time(session, 100);
    expect(session.state.phase).toBe("terminal");
    expect(JSON.stringify({ log: session.log, frames: session.frames })).not.toContain(noise);
    expect(
      verifyPluginReplay({
        plugin: data.plugin,
        config: data.config,
        seed: "clock",
        log: session.log,
      }),
    ).toEqual({ ok: true });
  });

  test("exhausted action and sensing allowances reject unbounded repeated input without retention", () => {
    const data = fixture({ allowNoise: true });
    let session = time(data.session, 0);
    session = act(session, seats[0], { reject: true });
    for (let count = 0; count < 2; count++)
      session = step(session, {
        kind: "callTool",
        seat: seats[0],
        tool: "match.scan",
        input: {},
      }).session;
    const before = session;
    const noise = "y".repeat(60000);
    for (let attempt = 0; attempt < 150; attempt++) {
      session = act(session, seats[0], { noise });
      session = step(session, {
        kind: "callTool",
        seat: seats[0],
        tool: "match.scan",
        input: {},
      }).session;
    }
    expect(session === before).toBe(true);
    expect(session.log === before.log).toBe(true);
    expect(session.frames === before.frames).toBe(true);
    session = time(session, 100);
    expect(
      verifyPluginReplay({
        plugin: data.plugin,
        config: data.config,
        seed: "clock",
        log: session.log,
      }),
    ).toEqual({ ok: true });
  });

  test("equal host timestamps do not accumulate clock commands or frames", () => {
    const { session } = fixture();
    const started = time(session, 0);
    let current = started;
    for (let attempt = 0; attempt < 150; attempt++) current = time(current, 0);
    expect(current === started).toBe(true);
  });
});

test("expiry defaults stop when a direct phase transition starts a fresh decision", () => {
  for (const timing of [
    { playerTotalMs: null, decisionLimitMs: 50 },
    {
      playerTotalMs: null,
      phaseLimits: {
        play: { durationMs: 50, close: "deadline" as const },
        next: { durationMs: 50, close: "deadline" as const },
      },
    },
  ]) {
    let { session } = fixture({ simultaneous: true, directPhases: true, timing });
    session = time(time(session, 0), 50);
    expect(session.state.phase).toBe("next");
    expect(session.state.turns).toBe(1);
    expect(clockSnapshot(session, seats[1])?.deadline).toBe(100);
    session = time(session, 100);
    expect(session.state.phase).toBe("terminal");
    expect(session.state.turns).toBe(2);
  }
});

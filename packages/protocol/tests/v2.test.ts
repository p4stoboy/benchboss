import { describe, expect, it } from "bun:test";
import * as protocol from "../src/index";

const timing = {
  playerTotalMs: 600000,
  decisionLimitMs: null,
  phaseLimits: { discussion: { durationMs: 1000, close: "deadline" } },
  clockVisibility: "private",
};
const resources = {
  fuel: { amount: 3, reset: "match", visibility: "private" },
  messages: { amount: 2, reset: "phase", visibility: "public" },
};
const clock = {
  sampledAt: 1000,
  remainingMs: 2000,
  running: true,
  deadline: 3000,
  phaseId: "match:phase:0",
  phaseDeadline: null,
};
const observation = {
  protocolVersion: 2,
  matchId: "match",
  seat: "seat:0",
  phase: "discussion",
  phaseId: "match:phase:0",
  publicState: {},
  privateState: {},
  legalTools: ["match.speak"],
  decisionId: "decision:0",
  actionOffers: [
    { tool: "match.speak", phase: "discussion", description: "Speak", jsonSchema: {} },
  ],
  resources: { fuel: 3, messages: 2 },
  participation: { status: "acting" },
  clock,
};

describe("v2 policies", () => {
  it("accepts independent timing constraints and a fully disabled policy", () => {
    expect(protocol.validateTimingPolicy(timing).ok).toBe(true);
    expect(
      protocol.validateTimingPolicy({ ...timing, playerTotalMs: null, phaseLimits: {} }).ok,
    ).toBe(true);
  });

  it("rejects nonpositive, fractional and unsafe durations", () => {
    for (const value of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "100",
    ]) {
      expect(protocol.validateTimingPolicy({ ...timing, playerTotalMs: value }).ok).toBe(false);
      expect(protocol.validateTimingPolicy({ ...timing, decisionLimitMs: value }).ok).toBe(false);
      expect(
        protocol.validateTimingPolicy({
          ...timing,
          phaseLimits: { x: { durationMs: value, close: "deadline" } },
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects unknown fields, closure modes and timing visibility", () => {
    for (const value of [
      { ...timing, incrementMs: 1 },
      { ...timing, clockVisibility: "hidden" },
      { ...timing, phaseLimits: { x: { durationMs: 1, close: "ready" } } },
      { ...timing, phaseLimits: { x: { durationMs: 1, close: "deadline", extra: true } } },
      { ...timing, phaseLimits: JSON.parse('{"__proto__":{"durationMs":1,"close":"deadline"}}') },
    ])
      expect(protocol.validateTimingPolicy(value).ok).toBe(false);
  });

  it("accepts arbitrary named resources including zero and maximum safe-integer units", () => {
    expect(protocol.validateResources(resources).ok).toBe(true);
    expect(
      protocol.validateResources({
        power_cells: { amount: 0, reset: "decision", visibility: "public" },
        fuel: { amount: Number.MAX_SAFE_INTEGER, reset: "match", visibility: "private" },
      }).ok,
    ).toBe(true);
    expect(protocol.validateResources({}).ok).toBe(true);
  });

  it("rejects malformed resource names, amounts and policies", () => {
    for (const name of [
      "",
      "constructor",
      "prototype",
      "__proto__",
      "MixedCase",
      "has space",
      "1fuel",
    ]) {
      const value = Object.fromEntries([[name, resources.fuel]]);
      expect(protocol.validateResources(value).ok).toBe(false);
    }
    for (const amount of [
      -1,
      0.3,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "3",
      null,
    ]) {
      expect(protocol.validateResources({ fuel: { ...resources.fuel, amount } }).ok).toBe(false);
    }
    for (const value of [
      { fuel: { ...resources.fuel, reset: "turn" } },
      { fuel: { ...resources.fuel, visibility: "secret" } },
      { fuel: { ...resources.fuel, extra: 1 } },
      { fuel: null },
      [],
      null,
      Object.create({ fuel: resources.fuel }),
    ])
      expect(protocol.validateResources(value).ok).toBe(false);
  });

  it("requires metering to name a declared resource with a nonnegative safe-integer cost", () => {
    expect(protocol.validateMetering({}, resources).ok).toBe(true);
    expect(
      protocol.validateMetering(
        {
          action: { resource: "fuel", cost: 1 },
          invalidAction: { resource: "messages", cost: 0 },
        },
        resources,
      ).ok,
    ).toBe(true);
    for (const value of [
      { action: { resource: "unknown", cost: 1 } },
      { action: { resource: "constructor", cost: 1 } },
      { action: { resource: "fuel", cost: -1 } },
      { action: { resource: "fuel", cost: 0.1 } },
      { action: { resource: "fuel", cost: Number.MAX_SAFE_INTEGER + 1 } },
      { action: { resource: "fuel", cost: Number.MAX_VALUE } },
      { action: { resource: "fuel", cost: Number.NaN } },
      { action: { resource: "fuel", cost: Number.POSITIVE_INFINITY } },
      { action: { resource: "fuel", cost: 1, reset: "match" } },
      { invalid: { resource: "fuel", cost: 1 } },
    ])
      expect(protocol.validateMetering(value, resources).ok).toBe(false);
  });
});

describe("versioned envelopes", () => {
  it("accepts every current lifecycle message", () => {
    for (const value of [
      {
        protocolVersion: 2,
        kind: "turn",
        matchId: "match",
        seat: "seat:0",
        observation,
        deadline: 3000,
      },
      {
        protocolVersion: 2,
        kind: "waiting",
        matchId: "match",
        seat: "seat:0",
        observation: {
          ...observation,
          participation: { status: "waiting" },
          actionOffers: [],
          legalTools: [],
          clock: { ...clock, running: false, deadline: null },
        },
        deadline: null,
      },
      {
        protocolVersion: 2,
        kind: "seat_finished",
        matchId: "match",
        seat: "seat:0",
        reason: "eliminated",
      },
      { protocolVersion: 2, kind: "match_over", matchId: "match", result: { "seat:0": 1 } },
      { protocolVersion: 2, kind: "match_aborted", matchId: "match", reason: "game_error" },
      { protocolVersion: 2, kind: "idle" },
    ])
      expect(protocol.validateNextEnvelope(value).ok).toBe(true);
  });

  it("rejects unversioned legacy responses and unknown versions, kinds and fields", () => {
    for (const value of [
      { kind: "idle" },
      { protocolVersion: 1, kind: "idle" },
      { protocolVersion: 3, kind: "idle" },
      { protocolVersion: 2, kind: "thinking" },
      { protocolVersion: 2, kind: "idle", privateClock: clock },
      {
        protocolVersion: 2,
        kind: "match_over",
        matchId: "match",
        result: { "seat:0": Number.NaN },
      },
    ])
      expect(protocol.validateNextEnvelope(value).ok).toBe(false);
  });

  it("rejects malformed observation accounting and mismatched assignment identity", () => {
    const valid = {
      protocolVersion: 2,
      kind: "turn",
      matchId: "match",
      seat: "seat:0",
      observation,
      deadline: 3000,
    };
    for (const value of [
      { ...valid, seat: "seat:1" },
      { ...valid, matchId: "other" },
      { ...valid, observation: { ...observation, budgets: {} } },
      { ...valid, observation: { ...observation, resources: { fuel: -1 } } },
      { ...valid, observation: { ...observation, participation: { status: "active" } } },
      { ...valid, observation: { ...observation, clock: { ...clock, remainingMs: -1 } } },
      { ...valid, observation: { ...observation, clock: { ...clock, phaseId: "different" } } },
    ])
      expect(protocol.validateNextEnvelope(value).ok).toBe(false);
  });

  it("validates submit responses without accepting private extra metadata", () => {
    expect(
      protocol.validateSubmitEnvelope({ protocolVersion: 2, ok: true, reason: "ok", observation })
        .ok,
    ).toBe(true);
    for (const value of [
      { ok: true, reason: "ok" },
      { protocolVersion: 2, ok: true, reason: "ok", elapsed: 1 },
      {
        protocolVersion: 2,
        ok: true,
        reason: "ok",
        observation: { ...observation, resources: { fuel: -1 } },
      },
    ])
      expect(protocol.validateSubmitEnvelope(value).ok).toBe(false);
  });

  it("accepts supported capabilities and rejects unknown feature requirements", () => {
    expect(protocol.validateCapabilities(protocol.SERVER_CAPABILITIES).ok).toBe(true);
    expect(protocol.validateCapabilities({ protocolVersion: 1 }).ok).toBe(false);
    expect(
      protocol.validateCapabilities({ ...protocol.SERVER_CAPABILITIES, features: ["unknown"] }).ok,
    ).toBe(false);
    expect(
      protocol.validateCapabilities({
        ...protocol.SERVER_CAPABILITIES,
        supportedProtocolVersions: [3],
      }).ok,
    ).toBe(false);
  });
});

describe("serializable policy records", () => {
  it("rejects hidden resources and metering before object enumeration can drop them", () => {
    const hiddenResources = Object.defineProperty({}, "fuel", { value: resources.fuel });
    expect(protocol.validateResources(hiddenResources).ok).toBe(false);
    expect(
      protocol.validateMetering({ action: { resource: "fuel", cost: 1 } }, hiddenResources).ok,
    ).toBe(false);
    const hiddenMetering = Object.defineProperty({}, "action", {
      value: { resource: "missing", cost: -1 },
    });
    expect(protocol.validateMetering(hiddenMetering, {}).ok).toBe(false);
  });

  it("rejects symbols, accessors and inherited policy records without invoking accessors", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "fuel", {
      enumerable: true,
      get: () => {
        reads++;
        return resources.fuel;
      },
    });
    for (const value of [
      accessor,
      { [Symbol("fuel")]: resources.fuel },
      Object.create(resources),
    ]) {
      expect(protocol.validateResources(value).ok).toBe(false);
    }
    expect(reads).toBe(0);
  });
});

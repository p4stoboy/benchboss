import { describe, expect, it } from "bun:test";
import { validateObservation, validateSubmitEnvelope } from "@benchboss/protocol";
import { ObservationEnvelope, SubmitResultEnvelope } from "@benchboss/schemas";

const valid = {
  protocolVersion: 1,
  matchId: "match",
  phase: "move",
  phaseId: "match:0",
  seat: "seat:0",
  publicState: {},
  privateState: {},
  legalTools: [],
  decisionId: "decision:0",
  actionOffers: [],
  resources: { messages: 1 },
  participation: { status: "waiting" },
  clock: {
    sampledAt: 1,
    remainingMs: null,
    running: false,
    deadline: null,
    phaseId: "match:0",
    phaseDeadline: null,
  },
};

describe("observation schema and protocol agreement", () => {
  it("accepts protocol observations in both public validators", () => {
    expect(validateObservation(valid).ok).toBe(true);
    expect(ObservationEnvelope.safeParse(valid).success).toBe(true);
  });

  it("rejects malformed or prototype resource keys before a parser can strip them", () => {
    for (const resources of [
      JSON.parse('{"__proto__":1}'),
      { constructor: 1 },
      { messages: Number.NaN },
      { messages: -1 },
      { messages: 0.3 },
      { messages: Number.MAX_SAFE_INTEGER + 1 },
      { messages: Number.MAX_VALUE },
    ]) {
      expect(validateObservation({ ...valid, resources }).ok).toBe(false);
      expect(ObservationEnvelope.safeParse({ ...valid, resources }).success).toBe(false);
    }
  });
});

describe("envelope plain-data boundaries", () => {
  it("rejects inherited, hidden, symbol and accessor properties at every observation record boundary", () => {
    let reads = 0;
    const inherited = Object.create({ fuel: 1 });
    const hidden = Object.defineProperty({}, "fuel", { value: 1 });
    const symbol = { [Symbol("fuel")]: 1 };
    const accessor = Object.defineProperty({}, "fuel", {
      enumerable: true,
      get: () => {
        reads++;
        return 1;
      },
    });
    for (const badRecord of [inherited, hidden, symbol, accessor]) {
      for (const field of ["resources", "publicState", "privateState"]) {
        const value = { ...valid, [field]: badRecord };
        expect(validateObservation(value).ok).toBe(false);
        expect(ObservationEnvelope.safeParse(value).success).toBe(false);
      }
    }
    for (const value of [
      Object.create(valid),
      { ...valid, participation: Object.create(valid.participation) },
      { ...valid, clock: Object.create(valid.clock) },
      {
        ...valid,
        actionOffers: [
          Object.create({ tool: "match.move", phase: "move", description: "move", jsonSchema: {} }),
        ],
      },
      {
        ...valid,
        actionOffers: [
          { tool: "match.move", phase: "move", description: "move", jsonSchema: inherited },
        ],
      },
    ]) {
      expect(validateObservation(value).ok).toBe(false);
      expect(ObservationEnvelope.safeParse(value).success).toBe(false);
    }
    expect(reads).toBe(0);
  });

  it("accepts null-prototype records and fractional clock samples with integer resource units", () => {
    const value = {
      ...valid,
      resources: Object.assign(Object.create(null), { fuel: 1 }),
      publicState: Object.create(null),
      clock: { ...valid.clock, sampledAt: 0.5, remainingMs: 99.5 },
    };
    expect(validateObservation(value).ok).toBe(true);
    expect(ObservationEnvelope.safeParse(value).success).toBe(true);
  });

  it("rejects nonplain submit records and explicitly undefined optional fields in both validators", () => {
    const submit = { protocolVersion: 1, ok: true, reason: "ok" };
    for (const value of [
      Object.create(submit),
      { ...submit, result: Object.create({ secret: 1 }) },
      { ...submit, result: undefined },
      { ...submit, observation: undefined },
    ]) {
      expect(validateSubmitEnvelope(value).ok).toBe(false);
      expect(SubmitResultEnvelope.safeParse(value).success).toBe(false);
    }
  });
});

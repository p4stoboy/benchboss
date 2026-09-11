import { describe, expect, it } from "bun:test";
import { ObservationEnvelope, SubmitResultEnvelope } from "../src/index";

const observation = {
  protocolVersion: 2,
  matchId: "m1",
  phase: "discussion",
  phaseId: "m1:0",
  seat: "seat:0",
  publicState: {},
  privateState: {},
  legalTools: [],
  decisionId: "m1:seat:0:0",
  actionOffers: [],
  resources: { fuel: 0 },
  participation: { status: "waiting" },
  clock: {
    sampledAt: 1,
    remainingMs: null,
    running: false,
    deadline: null,
    phaseId: "m1:0",
    phaseDeadline: null,
  },
};

describe("current schemas", () => {
  it("accepts current observations with explicit lifecycle and disabled clock constraints", () => {
    expect(ObservationEnvelope.safeParse(observation).success).toBe(true);
  });
  it("rejects legacy budgets, negative allowances and unknown nested lifecycle metadata", () => {
    for (const value of [
      { ...observation, budgets: {} },
      { ...observation, resources: { fuel: -1 } },
      { ...observation, resources: { constructor: 1 } },
      { ...observation, participation: { status: "waiting", hidden: true } },
      { ...observation, clock: { ...observation.clock, unknown: 1 } },
      { ...observation, clock: { ...observation.clock, phaseId: "other" } },
    ])
      expect(ObservationEnvelope.safeParse(value).success).toBe(false);
  });
  it("accepts versioned submit responses and rejects unversioned submit responses", () => {
    expect(
      SubmitResultEnvelope.safeParse({ protocolVersion: 2, ok: true, reason: "ok", observation })
        .success,
    ).toBe(true);
    expect(SubmitResultEnvelope.safeParse({ accepted: true, reason: "ok" }).success).toBe(false);
  });
});

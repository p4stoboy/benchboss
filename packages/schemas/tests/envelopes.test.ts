import { describe, expect, test } from "bun:test";
import {
  LegacyObservationEnvelope as ObservationEnvelope,
  LegacySubmitResultEnvelope as SubmitResultEnvelope,
} from "../src/index";

const validObs = {
  matchId: "m1",
  phase: "throw",
  seat: "seat:0",
  publicState: { round: 1 },
  privateState: { role: "loyal" },
  legalTools: ["match.throw"],
  budgets: { toolCallsPerTurn: 3 },
};

describe("shared envelopes", () => {
  test("observation_envelope_accepts_well_formed_observation", () => {
    expect(ObservationEnvelope.parse(validObs)).toEqual(validObs);
  });

  test("strict_observation_rejects_unknown_top_level_key", () => {
    const bad = { ...validObs, secretLeak: "evil" };
    expect(() => ObservationEnvelope.parse(bad)).toThrow();
  });

  test("submit_result_envelope_accepts_optional_committed_action_id", () => {
    const ok = { accepted: true, reason: "ok", committedActionId: "a1" };
    expect(SubmitResultEnvelope.parse(ok)).toEqual(ok);
  });

  test("strict_submit_result_rejects_unknown_key", () => {
    expect(() => SubmitResultEnvelope.parse({ accepted: false, reason: "no", extra: 1 })).toThrow();
  });
});

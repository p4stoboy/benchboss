import { describe, expect, test } from "bun:test";
import {
  proposeTeamSchema,
  scanAlignmentInputSchema,
  speechActInputSchema,
  speechActSchema,
  traceOperationSchema,
} from "../src/schemas";

describe("spy schemas", () => {
  test("accepts_a_well_formed_accuse_speech_act", () => {
    const parsed = speechActSchema.safeParse({
      act: "accuse",
      target: "seat:2",
      confidence: 0.7,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects_an_unknown_act", () => {
    const parsed = speechActSchema.safeParse({
      act: "bribe",
      target: "seat:1",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects_a_free_text_field", () => {
    const parsed = speechActSchema.safeParse({
      act: "pass",
      message: "trust me, I am loyal",
    });
    expect(parsed.success).toBe(false);
  });

  test("emits_input_schema_with_additional_properties_false", () => {
    const speechActAnyOf = speechActInputSchema.anyOf as Array<Record<string, unknown>>;
    expect(Array.isArray(speechActAnyOf)).toBe(true);
    expect(speechActAnyOf.every((b) => b.additionalProperties === false)).toBe(true);
    expect(scanAlignmentInputSchema.additionalProperties).toBe(false);
  });

  test("propose_team_requires_a_seat_array", () => {
    const ok = proposeTeamSchema.safeParse({ team: ["seat:0", "seat:1"] });
    const bad = proposeTeamSchema.safeParse({ team: "seat:0" });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

describe("trace_operation input", () => {
  test("takes an opIndex and nothing else", () => {
    expect(traceOperationSchema.safeParse({ opIndex: 2 }).success).toBe(true);
    expect(traceOperationSchema.safeParse({ round: 2 }).success).toBe(false);
    expect(traceOperationSchema.safeParse({ opIndex: -1 }).success).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toInputSchema } from "../src/index";

describe("toInputSchema", () => {
  test("emits_additional_properties_false_for_strict_object", () => {
    const schema = z.object({ throw: z.enum(["rock", "paper", "scissors"]) }).strict();
    const json = toInputSchema(schema);
    expect(json.additionalProperties).toBe(false);
    expect((json.properties as Record<string, unknown>).throw).toBeDefined();
  });

  test("throws_when_schema_is_not_strict", () => {
    const loose = z.object({ throw: z.string() });
    expect(() => toInputSchema(loose)).toThrow(/not strict/);
  });

  test("strict_discriminated_union_emits_per_branch_additionalProperties_false", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), x: z.number() }).strict(),
      z.object({ kind: z.literal("b"), y: z.string() }).strict(),
    ]);
    const json = toInputSchema(schema);
    const anyOf = json.anyOf as Array<Record<string, unknown>>;
    expect(Array.isArray(anyOf)).toBe(true);
    expect(anyOf.length).toBeGreaterThan(0);
    expect(anyOf.every((b) => b.additionalProperties === false)).toBe(true);
  });

  test("discriminated_union_with_non_strict_branch_throws", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), x: z.number() }).strict(),
      z.object({ kind: z.literal("b"), y: z.string() }),
    ]);
    expect(() => toInputSchema(schema)).toThrow(/strict/);
  });
});

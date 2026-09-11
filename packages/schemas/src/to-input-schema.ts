import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type ZodObjectDef = { unknownKeys?: string };
type ZodDiscriminatedUnionDef = { options: z.ZodTypeAny[] };

// zod-to-json-schema@3.23 emits additionalProperties:false for all objects, so we check the Zod schema's strictness directly rather than the emitted JSON.
function isStrictObject(schema: z.ZodTypeAny): boolean {
  const def = schema._def as ZodObjectDef;
  return def.unknownKeys === "strict";
}

function isStrictDiscriminatedUnion(schema: z.ZodTypeAny): boolean {
  if (schema._def.typeName !== "ZodDiscriminatedUnion") return false;
  const def = schema._def as ZodDiscriminatedUnionDef;
  return def.options.every((opt) => isStrictObject(opt));
}

export function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (!isStrictObject(schema) && !isStrictDiscriminatedUnion(schema)) {
    throw new Error(
      "toInputSchema requires a Zod .strict() schema (additionalProperties:false); schema is not strict",
    );
  }
  return zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

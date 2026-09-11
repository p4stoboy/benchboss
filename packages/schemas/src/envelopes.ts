import { z } from "zod";

export const LegacyObservationEnvelope = z
  .object({
    matchId: z.string(),
    phase: z.string(),
    seat: z.string(),
    publicState: z.record(z.unknown()),
    privateState: z.record(z.unknown()),
    legalTools: z.array(z.string()),
    decisionId: z.string().optional(),
    actionOffers: z
      .array(
        z.object({
          tool: z.string(),
          phase: z.string(),
          description: z.string(),
          jsonSchema: z.record(z.unknown()),
        }),
      )
      .optional(),
    budgets: z.record(z.number()),
  })
  .strict();

export const LegacySubmitResultEnvelope = z
  .object({
    accepted: z.boolean(),
    reason: z.string(),
    committedActionId: z.string().optional(),
  })
  .strict();

export type LegacyObservation = z.infer<typeof LegacyObservationEnvelope>;
export type LegacySubmitResultDto = z.infer<typeof LegacySubmitResultEnvelope>;

// Keep this plain-data gate in parity with protocol validation; schemas has no protocol dependency.
function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
  });
}

function plainRecord<T extends z.ZodTypeAny>(schema: T) {
  return z
    .custom<Record<string, unknown>>(isPlainDataRecord, "expected a plain data record")
    .pipe(schema);
}

const name = z.string().min(1);
const amount = z.number().finite().nonnegative();
const resourceAmount = amount.int().max(Number.MAX_SAFE_INTEGER);
const resourceName = name
  .regex(/^[a-z][a-z0-9_]*$/)
  .refine(
    (key) => key !== "constructor" && key !== "prototype" && key !== "__proto__",
    "invalid resource name",
  );
const unknownRecord = plainRecord(z.record(z.unknown()));

export const ParticipationSchema = plainRecord(
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("acting") }).strict(),
    z.object({ status: z.literal("waiting") }).strict(),
    z.object({ status: z.literal("finished"), reason: name }).strict(),
  ]),
);

export const ClockSnapshotSchema = plainRecord(
  z
    .object({
      sampledAt: amount,
      remainingMs: amount.nullable(),
      running: z.boolean(),
      deadline: amount.nullable(),
      phaseId: name,
      phaseDeadline: amount.nullable(),
    })
    .strict(),
);

export const ResourceBalancesSchema = plainRecord(z.record(resourceName, resourceAmount));

export const ObservationEnvelope = plainRecord(
  z
    .object({
      protocolVersion: z.literal(2),
      matchId: name,
      phase: name,
      phaseId: name,
      seat: name,
      publicState: unknownRecord,
      privateState: unknownRecord,
      legalTools: z.array(name),
      decisionId: name,
      actionOffers: z.array(
        plainRecord(
          z
            .object({
              tool: name,
              phase: name,
              description: z.string(),
              jsonSchema: unknownRecord,
            })
            .strict(),
        ),
      ),
      resources: ResourceBalancesSchema,
      participation: ParticipationSchema,
      clock: ClockSnapshotSchema,
    })
    .strict(),
).refine((value) => value.phaseId === value.clock.phaseId, "clock phase identity mismatch");

export const SubmitResultEnvelope = plainRecord(
  z
    .object({
      protocolVersion: z.literal(2),
      ok: z.boolean(),
      reason: z.string(),
      observation: ObservationEnvelope.optional(),
      result: unknownRecord.optional(),
    })
    .strict(),
).refine(
  (value) =>
    (!Object.hasOwn(value, "observation") || value.observation !== undefined) &&
    (!Object.hasOwn(value, "result") || value.result !== undefined),
  "optional fields must be omitted or defined",
);

export type Observation = z.infer<typeof ObservationEnvelope>;
export type SubmitResultDto = z.infer<typeof SubmitResultEnvelope>;

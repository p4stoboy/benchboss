import { z } from "zod";

export const ObservationEnvelope = z
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

export const SubmitResultEnvelope = z
  .object({
    accepted: z.boolean(),
    reason: z.string(),
    committedActionId: z.string().optional(),
  })
  .strict();

export type Observation = z.infer<typeof ObservationEnvelope>;
export type SubmitResultDto = z.infer<typeof SubmitResultEnvelope>;

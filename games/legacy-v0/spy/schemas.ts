import { toInputSchema } from "@benchboss/schemas";
import { z } from "zod";

const seatRef = z.string().regex(/^seat:\d+$/);

export const SPEECH_ACTS = [
  "claim_alignment",
  "claim_role",
  "report_intel",
  "accuse",
  "vouch",
  "request_claim",
  "commit_vote",
  "challenge_consistency",
  "retract",
  "pass",
] as const;

// Optional shared fields that never conflict with per-variant required fields.
const sharedOpts = {
  confidence: z.number().min(0).max(1).nullable().optional(),
};

// Discriminated union on "act"; NO free-text field. Truth is never checked; only
// legality + budget are enforced — lying is the game.
export const speechActSchema = z.discriminatedUnion("act", [
  z
    .object({
      act: z.literal("claim_alignment"),
      subject: seatRef,
      allegiance: z.enum(["loyal", "mole"]),
      target: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("claim_role"),
      roleClaim: z.enum(["loyal", "mole", "handler", "deepcover", "analyst"]),
      subject: seatRef.nullable().optional(),
      target: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("report_intel"),
      subject: seatRef,
      allegiance: z.enum(["loyal", "mole"]),
      target: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("accuse"),
      target: seatRef,
      subject: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("vouch"),
      target: seatRef,
      subject: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("request_claim"),
      target: seatRef,
      subject: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("commit_vote"),
      evidenceRef: z.string(),
      subject: seatRef.nullable().optional(),
      target: seatRef.nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("challenge_consistency"),
      evidenceRef: z.string(),
      subject: seatRef.nullable().optional(),
      target: seatRef.nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("retract"),
      evidenceRef: z.string(),
      subject: seatRef.nullable().optional(),
      target: seatRef.nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
  z
    .object({
      act: z.literal("pass"),
      subject: seatRef.nullable().optional(),
      target: seatRef.nullable().optional(),
      evidenceRef: z.string().nullable().optional(),
      ...sharedOpts,
    })
    .strict(),
]);

export const proposeTeamSchema = z.object({ team: z.array(seatRef).min(1) }).strict();
export const voteSchema = z.object({ vote: z.enum(["approve", "reject"]) }).strict();
export const missionActionSchema = z.object({ sabotage: z.boolean() }).strict();
export const submitPhaseEndSchema = z.object({}).strict();

export const scanAlignmentSchema = z.object({ target: seatRef }).strict();
export const auditStatementSchema = z.object({ actId: z.string() }).strict();
export const traceOperationSchema = z.object({ opIndex: z.number().int().min(0) }).strict();
export const assassinateSchema = z.object({ target: seatRef }).strict();

// M3 deception sensing schemas
export const plantMisinfoSchema = z.object({ target: seatRef }).strict();
export const counterIntelSchema = z.object({}).strict();
export const protectSourceSchema = z.object({}).strict();

export const speechActInputSchema = toInputSchema(speechActSchema);
export const proposeTeamInputSchema = toInputSchema(proposeTeamSchema);
export const voteInputSchema = toInputSchema(voteSchema);
export const missionActionInputSchema = toInputSchema(missionActionSchema);
export const submitPhaseEndInputSchema = toInputSchema(submitPhaseEndSchema);
export const scanAlignmentInputSchema = toInputSchema(scanAlignmentSchema);
export const auditStatementInputSchema = toInputSchema(auditStatementSchema);
export const traceOperationInputSchema = toInputSchema(traceOperationSchema);
export const assassinateInputSchema = toInputSchema(assassinateSchema);
export const plantMisinfoInputSchema = toInputSchema(plantMisinfoSchema);
export const counterIntelInputSchema = toInputSchema(counterIntelSchema);
export const protectSourceInputSchema = toInputSchema(protectSourceSchema);

export type SpeechAct = z.infer<typeof speechActSchema>;
// The BARE schema-inferred action union. No synthetic `kind` discriminant: the
// server hands GameModule.submit the raw schema-validated tool input, which
// submit routes on state.phase + the input's own fields.
export type SpyAction =
  | SpeechAct
  | z.infer<typeof proposeTeamSchema>
  | z.infer<typeof voteSchema>
  | z.infer<typeof missionActionSchema>
  | z.infer<typeof submitPhaseEndSchema>
  | z.infer<typeof assassinateSchema>;

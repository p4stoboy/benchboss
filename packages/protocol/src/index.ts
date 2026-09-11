import Ajv from "ajv";

const schemaValidator = new Ajv({ strict: false, allErrors: true });

export function validateSchema(
  schema: JsonSchema,
  input: unknown,
): { ok: boolean; reason?: string } {
  try {
    const ok = schemaValidator.validate(schema, input);
    return ok ? { ok: true } : { ok: false, reason: schemaValidator.errorsText() };
  } catch {
    return { ok: false, reason: "invalid JSON Schema" };
  }
}

export * from "./legacy";
export * from "./v2";
export * from "./validation";

import type { ClockSnapshot, GameRevision, ResourceBalances, ResultCause } from "./v2";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export interface GameManifestBase {
  id: string;
  revision: string;
  title: string;
  description: string;
  rulesSource: string;
  seatCounts: number[];
  defaultSeats: number;
  rulesSchema: JsonSchema;
  defaultRules: Record<string, unknown>;
  roundStructure: { phase: string; what: string }[];
  winConditions: string[];
  safeDefaults: string[];
  disclosure: "full-after-terminal";
}

export interface ActionOffer {
  tool: string;
  phase: string;
  description: string;
  jsonSchema: JsonSchema;
}

export interface ActionInvocation {
  tool: string;
  input: unknown;
}

export interface GameProgress {
  phase: string;
  label: string;
  current: number;
  total: number | null;
}

export interface SeatOutcome {
  seat: string;
  outcome: "win" | "loss" | "draw";
  placement: number;
  team?: string;
  metrics: { label: string; value: number }[];
}

export interface GameResult {
  cause?: ResultCause;
  summary: string;
  seats: SeatOutcome[];
}

export type SpectatorBlock =
  | { kind: "text"; title: string; text: string }
  | { kind: "metrics"; title: string; values: { label: string; value: string | number }[] }
  | { kind: "participants"; title: string; seats: { seat: string; status: string }[] }
  | { kind: "progress"; title: string; current: number; total: number | null }
  | { kind: "table"; title: string; columns: string[]; rows: (string | number)[][] }
  | { kind: "list"; title: string; items: string[] };

export interface SpectatorView {
  version: 1;
  progress: GameProgress;
  blocks: SpectatorBlock[];
  result: GameResult | null;
  clocks?: Record<string, ClockSnapshot>;
  resources?: Record<string, ResourceBalances>;
}

export interface PublicFrame {
  seq: number;
  view: SpectatorView;
}

export interface ReplayPresentation {
  identity: GameRevision;
  frames: PublicFrame[];
}

export interface SubmissionIdentity {
  decisionId: string;
  requestId: string;
}

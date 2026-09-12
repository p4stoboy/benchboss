import {
  type NextEnvelope,
  type Observation,
  SERVER_CAPABILITIES,
  type SubmitEnvelope,
} from "@benchboss/protocol";
export const capabilities = SERVER_CAPABILITIES;
export const observation = (decisionId: string): Observation => ({
  protocolVersion: 1,
  matchId: "m",
  phase: "play",
  phaseId: "m:0",
  seat: "seat:0",
  publicState: {},
  privateState: {},
  legalTools: ["move"],
  decisionId,
  actionOffers: [
    { tool: "move", phase: "play", description: "Move", jsonSchema: { type: "object" } },
  ],
  resources: {},
  participation: { status: "acting" },
  clock: {
    sampledAt: 0,
    remainingMs: 1000,
    running: true,
    deadline: 1000,
    phaseId: "m:0",
    phaseDeadline: null,
  },
});
export const turn = (decisionId: string): NextEnvelope => ({
  protocolVersion: 1,
  kind: "turn",
  matchId: "m",
  seat: "seat:0",
  observation: observation(decisionId),
  deadline: 1000,
});
export const submitted = (decisionId?: string): SubmitEnvelope => ({
  protocolVersion: 1,
  ok: true,
  reason: "ok",
  ...(decisionId === undefined ? {} : { observation: observation(decisionId) }),
});

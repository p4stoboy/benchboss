import {
  RUNTIME_VERSION,
  isPlainDataRecord,
  validateMetering,
  validateResources,
  validateTimingPolicy,
} from "@benchboss/protocol";
import { mkSeatId } from "./types";
import type { MatchConfig, SeatId } from "./types";

export type TournamentPolicy = Pick<MatchConfig, "identity" | "timing" | "resources" | "metering">;
export interface ScheduledMatch {
  config: MatchConfig;
  seed: string;
  seedIndex: number;
  assignments: { seat: SeatId; agentId: string }[];
}

export interface TournamentArgs {
  agents: string[];
  gameId: string;
  seedBatch: string[];
  rotateSeatsAndRoles: boolean;
  rules?: Record<string, unknown>;
}

export function scheduleTournament(
  policy: TournamentPolicy,
  args: TournamentArgs,
): ScheduledMatch[] {
  const candidate: unknown = policy;
  if (!isPlainDataRecord(candidate)) throw Error("tournament policy must be a plain data record");
  if (
    !isPlainDataRecord(policy.identity) ||
    policy.identity.protocolVersion !== 1 ||
    policy.identity.runtimeVersion !== RUNTIME_VERSION ||
    policy.identity.gameId !== args.gameId ||
    typeof policy.identity.revision !== "string" ||
    policy.identity.revision.length === 0 ||
    !Object.keys(policy.identity).every((key) =>
      ["protocolVersion", "runtimeVersion", "gameId", "revision"].includes(key),
    ) ||
    !Object.keys(policy).every((key) =>
      ["identity", "timing", "resources", "metering"].includes(key),
    )
  )
    throw Error("invalid tournament identity or policy fields");
  for (const validation of [
    validateTimingPolicy(policy.timing),
    validateResources(policy.resources),
    validateMetering(policy.metering, policy.resources),
  ]) {
    if (!validation.ok) throw Error(validation.reason);
  }
  if (args.rules !== undefined && !isPlainDataRecord(args.rules))
    throw Error("tournament rules must be a plain data record");
  return args.seedBatch.map((seed, seedIndex) => {
    const seats = Array.from({ length: args.agents.length }, (_, i) => mkSeatId(i));
    const shift = args.rotateSeatsAndRoles ? seedIndex % args.agents.length : 0;
    const assignments = seats.map((seat, seatIndex) => {
      const agentId = args.agents[(seatIndex + shift) % args.agents.length];
      if (agentId === undefined) throw Error("missing tournament agent");
      return { seat, agentId };
    });
    return {
      config: {
        matchId: `${args.gameId}:${seed}`,
        gameId: args.gameId,
        seats,
        rules: structuredClone(args.rules ?? {}),
        ...structuredClone(policy),
      },
      seed,
      seedIndex,
      assignments,
    };
  });
}

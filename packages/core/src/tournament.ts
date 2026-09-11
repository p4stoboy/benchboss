import {
  RUNTIME_VERSION,
  isPlainDataRecord,
  validateMetering,
  validateResources,
  validateTimingPolicy,
} from "@benchboss/protocol";
import { mkSeatId } from "./types";
import type { BudgetConfig, CurrentMatchConfig, LegacyMatchConfig, SeatId } from "./types";

export type TournamentPolicy = Pick<
  CurrentMatchConfig,
  "identity" | "timing" | "resources" | "metering"
>;
export interface ScheduledMatch {
  config: CurrentMatchConfig;
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

function scheduleAssignments(
  args: TournamentArgs,
): { matchId: string; gameId: string; seats: SeatId[]; rules: Record<string, unknown> }[] {
  const { agents, gameId, seedBatch, rotateSeatsAndRoles } = args;
  const n = agents.length;
  return seedBatch.map((seed, seedIndex) => {
    const shift = rotateSeatsAndRoles ? seedIndex % n : 0;
    const seatAssignment = Array.from({ length: n }, (_, seatIdx) => agents[(seatIdx + shift) % n]);
    return {
      matchId: `${gameId}:${seed}`,
      gameId,
      seats: Array.from({ length: n }, (_, i) => mkSeatId(i)),
      rules: { ...structuredClone(args.rules ?? {}), seatAssignment, seedIndex, seed },
    };
  });
}

export function scheduleLegacyTournament(
  budgets: BudgetConfig,
  args: TournamentArgs,
): LegacyMatchConfig[] {
  return scheduleAssignments(args).map((config) => ({ ...config, budgets }));
}

export function scheduleTournament(
  policy: TournamentPolicy,
  args: TournamentArgs,
): ScheduledMatch[];
/** Compatibility overload for historical callers. */
export function scheduleTournament(
  budgets: BudgetConfig,
  args: TournamentArgs,
): LegacyMatchConfig[];
export function scheduleTournament(
  policy: TournamentPolicy | BudgetConfig,
  args: TournamentArgs,
): ScheduledMatch[] | LegacyMatchConfig[] {
  const candidate: unknown = policy;
  if (!isPlainDataRecord(candidate)) throw Error("tournament policy must be a plain data record");
  if (
    !Object.hasOwn(policy, "identity") &&
    !Object.hasOwn(policy, "timing") &&
    !Object.hasOwn(policy, "resources") &&
    !Object.hasOwn(policy, "metering")
  )
    return scheduleLegacyTournament(policy as BudgetConfig, args);
  const current = policy as TournamentPolicy;
  if (
    !isPlainDataRecord(current.identity) ||
    current.identity.protocolVersion !== 2 ||
    current.identity.runtimeVersion !== RUNTIME_VERSION ||
    current.identity.gameId !== args.gameId ||
    typeof current.identity.revision !== "string" ||
    current.identity.revision.length === 0 ||
    !Object.keys(current.identity).every((key) =>
      ["protocolVersion", "runtimeVersion", "gameId", "revision"].includes(key),
    ) ||
    !Object.keys(current).every((key) =>
      ["identity", "timing", "resources", "metering"].includes(key),
    )
  )
    throw Error("invalid tournament identity or policy fields");
  for (const validation of [
    validateTimingPolicy(current.timing),
    validateResources(current.resources),
    validateMetering(current.metering, current.resources),
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
        ...structuredClone(current),
      },
      seed,
      seedIndex,
      assignments,
    };
  });
}

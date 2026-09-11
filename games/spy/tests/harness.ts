import {
  type MatchConfig,
  type RatingTableRow,
  type SeatId,
  createRng,
  eventsToJsonl,
  mkSeatId,
  parseJsonl,
  scheduleTournament,
  verifyReplay,
} from "@benchboss/core";
import type { LegalActionSpec, Rng } from "@benchboss/core";
import {
  type Command,
  type MatchHandle,
  isTerminal,
  newSession,
  observe,
  sessionLog,
  sessionState,
  step,
} from "@benchboss/referee";
import type { Observation } from "@benchboss/schemas";
import { SPY_GAME_ID, makeSpyGame } from "../src/game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import { spySenseResolvers } from "../src/sensing";
import type { SpyState } from "../src/types";

// Minimal bot interface (no @benchboss/bots dependency)
interface MatchClient {
  getObservation(): Observation;
  legalActions(): LegalActionSpec[];
  callTool(
    tool: string,
    input: unknown,
  ): { ok: boolean; reason: string; result?: Record<string, unknown>; observation?: Observation };
  isOver(): boolean;
}

interface Bot {
  readonly name: string;
  chooseAction(client: MatchClient, rng: Rng): { tool: string; input: unknown } | null;
}

function runAgentLoop(bot: Bot, client: MatchClient, rng: Rng, maxSteps = 1): number {
  let accepted = 0;
  for (let s = 0; s < maxSteps && !client.isOver(); s++) {
    const choice = bot.chooseAction(client, rng);
    if (!choice) break;
    const res = client.callTool(choice.tool, choice.input);
    if (res.ok) accepted++;
  }
  return accepted;
}

const DISCUSSION_END = "match.submit_phase_end";

function spyActionSampler(spec: LegalActionSpec, rng: Rng): unknown {
  switch (spec.tool) {
    case "comms.send":
      return { act: "pass" };
    case "match.propose_team":
      return { team: [] };
    case "match.vote":
      return { vote: rng.pick(["approve", "reject"] as const) };
    case "match.mission_action":
      return { sabotage: false };
    case "match.submit_phase_end":
      return {};
    default:
      return {};
  }
}

interface ProposalPublicState {
  seats: SeatId[];
  leader: SeatId;
  teamSize: number;
}

function spyChooseTool(legalTools: string[], rng: Rng): string {
  if (legalTools.includes(DISCUSSION_END)) return DISCUSSION_END;
  return rng.pick(legalTools);
}

function SpyRandomBot(name: string): Bot {
  return {
    name,
    chooseAction(client: MatchClient, rng: Rng): { tool: string; input: unknown } | null {
      const legalTools = client.getObservation().legalTools;
      if (legalTools.length === 0) return null;
      const tool = spyChooseTool(legalTools, rng);
      const spec = client.legalActions().find((s) => s.tool === tool);
      if (spec === undefined) return null;
      if (tool === "match.assassinate") {
        const pub = client.getObservation().publicState as unknown as ProposalPublicState;
        return { tool, input: { target: pub.seats[0] } };
      }
      if (tool === "match.propose_team") {
        const pub = client.getObservation().publicState as unknown as ProposalPublicState;
        const ordered = [pub.leader, ...pub.seats.filter((s) => s !== pub.leader)];
        return { tool, input: { team: ordered.slice(0, pub.teamSize) } };
      }
      return { tool, input: spyActionSampler(spec, rng) };
    },
  };
}

const DEFAULT_BUDGETS = {
  wallClockMsPerDecision: 1000,
  toolCallsPerTurn: 8,
  intelOrScoutPoints: 3,
  simRolloutsPerTurn: 0,
  invalidRetries: 2,
};

function spyConfig(seed: string, seats: number, handler = false): MatchConfig {
  return {
    matchId: `spy:${seed}`,
    gameId: SPY_GAME_ID,
    seats: Array.from({ length: seats }, (_, i) => mkSeatId(i)),
    rules: handler ? { rounds: 5, handler: true } : { rounds: 5 },
    budgets: DEFAULT_BUDGETS,
  };
}

function spyResolvers(seed: string, _handler: boolean) {
  return spySenseResolvers(seed);
}

const terminalSummary = (s: SpyState): Record<string, unknown> => ({
  winner: s.winner,
  reason: s.winReason,
});

const resolveSummary = (s: SpyState, resolvedPhase: string): Record<string, unknown> => {
  if (resolvedPhase !== "operation") return {};
  const op = s.opResults.at(-1);
  if (op === undefined) return {};
  return { result: op.failed ? "fail" : "success", sabotageCount: op.sabotageCount };
};

export function makeSeatClient(
  handle: MatchHandle<SpyState>,
  seat: SeatId,
  game: ReturnType<typeof makeSpyGame>,
): MatchClient {
  return {
    getObservation: () => observe(handle.get(), seat) as Observation,
    legalActions: () => game.legalActions(sessionState(handle.get()), seat),
    callTool: (tool, input) => {
      const res = handle.advance({ kind: "callTool", seat, tool, input });
      return {
        ok: res.ok,
        reason: res.reason,
        result: res.result,
        observation: res.observation as Observation | undefined,
      };
    },
    isOver: () => isTerminal(handle.get()),
  };
}

export function runSpyMatch(opts: {
  seed: string;
  seats?: number;
  botSeedPrefix?: string;
  handler?: boolean;
}): {
  jsonl: string;
  score: Record<string, number>;
} {
  const seats = opts.seats ?? 5;
  const handler = opts.handler ?? false;
  const config = spyConfig(opts.seed, seats, handler);
  const game = makeSpyGame();
  let session = newSession<SpyState>({
    game,
    config,
    seed: opts.seed,
    phaseToTools: SPY_PHASE_TOOLS,
    currentPhase,
    isReady,
    safeDefault: spySafeDefault,
    senseResolvers: spyResolvers(opts.seed, handler),
    terminalSummary,
    resolveSummary,
  });
  const handle: MatchHandle<SpyState> = {
    get: () => session,
    advance: (cmd: Command) => {
      const r = step(session, cmd);
      session = r.session;
      return r.output;
    },
  };
  const prefix = opts.botSeedPrefix ?? "bot";
  let guard = 0;
  while (!isTerminal(session) && guard < 2000) {
    guard++;
    for (const seat of config.seats) {
      if (isTerminal(session)) break;
      const client = makeSeatClient(handle, seat, game);
      const bot = SpyRandomBot(`${prefix}:${seat}`);
      runAgentLoop(bot, client, createRng(`${opts.seed}:${seat}:${guard}`), 1);
    }
  }
  const score = game.score(sessionState(session)) as Record<string, number>;
  return { jsonl: eventsToJsonl(sessionLog(session)), score };
}

export function verifySpyReplay(opts: {
  jsonl: string;
  seed: string;
  seats?: number;
  handler?: boolean;
}): {
  ok: boolean;
  divergenceSeq?: number;
  detail?: string;
} {
  const seats = opts.seats ?? 5;
  const config = spyConfig(opts.seed, seats, opts.handler ?? false);
  const log = parseJsonl(opts.jsonl);
  return verifyReplay({
    game: makeSpyGame(),
    config,
    seed: opts.seed,
    log,
  });
}

export function runSpyTournament(opts: {
  agents: string[];
  seedBatch: string[];
  handler?: boolean;
}): {
  table: RatingTableRow[];
  matches: number;
  roleWinRate: Record<string, { asLoyal: number; asMole: number }>;
  alignmentTally: { loyalWins: number; loyalGames: number; moleWins: number; moleGames: number };
} {
  const handler = opts.handler ?? false;
  const configs = scheduleTournament(DEFAULT_BUDGETS, {
    agents: opts.agents,
    gameId: SPY_GAME_ID,
    seedBatch: opts.seedBatch,
    rotateSeatsAndRoles: true,
  });

  const counters: Record<
    string,
    { loyalGames: number; loyalWins: number; moleGames: number; moleWins: number }
  > = Object.fromEntries(
    opts.agents.map((a) => [a, { loyalGames: 0, loyalWins: 0, moleGames: 0, moleWins: 0 }]),
  );

  const aggregate: Record<string, number> = Object.fromEntries(opts.agents.map((a) => [a, 0]));
  const aggWins: Record<string, number> = Object.fromEntries(opts.agents.map((a) => [a, 0]));
  let matches = 0;

  for (const baseConfig of configs) {
    matches++;
    const config: MatchConfig = handler
      ? { ...baseConfig, rules: { ...baseConfig.rules, handler: true } }
      : baseConfig;
    const matchSeed = `${config.matchId}`;
    const game = makeSpyGame();
    let session = newSession<SpyState>({
      game,
      config,
      seed: matchSeed,
      phaseToTools: SPY_PHASE_TOOLS,
      currentPhase,
      isReady,
      safeDefault: spySafeDefault,
      senseResolvers: spyResolvers(matchSeed, handler),
      terminalSummary,
      resolveSummary,
    });
    const handle: MatchHandle<SpyState> = {
      get: () => session,
      advance: (cmd: Command) => {
        const r = step(session, cmd);
        session = r.session;
        return r.output;
      },
    };

    let guard = 0;
    while (!isTerminal(session) && guard < 2000) {
      guard++;
      for (const seat of config.seats) {
        if (isTerminal(session)) break;
        const client = makeSeatClient(handle, seat, game);
        const bot = SpyRandomBot(`${matchSeed}:${seat}`);
        runAgentLoop(bot, client, createRng(`${matchSeed}:${seat}:${guard}`), 1);
      }
    }

    const finalState = sessionState(session);
    const sc = game.score(finalState) as Record<string, number>;

    const seatAssignment = config.rules.seatAssignment;
    const assignmentArr = Array.isArray(seatAssignment) ? (seatAssignment as string[]) : [];

    config.seats.forEach((seat, idx) => {
      const agent = assignmentArr[idx] ?? opts.agents[idx % opts.agents.length] ?? "";
      if (!agent) return;
      const seatScore = sc[seat] ?? 0;
      const won = seatScore === 1;
      const agentAgg = aggregate[agent];
      if (agentAgg !== undefined) aggregate[agent] = agentAgg + seatScore;
      if (won) {
        const agentWins = aggWins[agent];
        if (agentWins !== undefined) aggWins[agent] = agentWins + 1;
      }
      const c = counters[agent];
      if (!c) return;
      const align = finalState.deal.alignmentBySeat[seat];
      if (!align) return;
      if (align === "loyal") {
        c.loyalGames++;
        if (won) c.loyalWins++;
      } else {
        c.moleGames++;
        if (won) c.moleWins++;
      }
    });
  }

  const table: RatingTableRow[] = opts.agents
    .map((a) => {
      const pts = aggregate[a] ?? 0;
      const wins = aggWins[a] ?? 0;
      const c = counters[a] ?? { loyalGames: 0, loyalWins: 0, moleGames: 0, moleWins: 0 };
      const totalGames = c.loyalGames + c.moleGames;
      return {
        agent: a,
        points: pts,
        winRate: totalGames > 0 ? wins / totalGames : 0,
      };
    })
    .sort((x, y) => y.points - x.points || y.winRate - x.winRate || x.agent.localeCompare(y.agent));

  const roleWinRate: Record<string, { asLoyal: number; asMole: number }> = {};
  let totalLoyalWins = 0;
  let totalLoyalGames = 0;
  let totalMoleWins = 0;
  let totalMoleGames = 0;
  for (const a of opts.agents) {
    const c = counters[a] ?? { loyalGames: 0, loyalWins: 0, moleGames: 0, moleWins: 0 };
    roleWinRate[a] = {
      asLoyal: c.loyalGames > 0 ? c.loyalWins / c.loyalGames : 0,
      asMole: c.moleGames > 0 ? c.moleWins / c.moleGames : 0,
    };
    totalLoyalWins += c.loyalWins;
    totalLoyalGames += c.loyalGames;
    totalMoleWins += c.moleWins;
    totalMoleGames += c.moleGames;
  }

  const alignmentTally = {
    loyalWins: totalLoyalWins,
    loyalGames: totalLoyalGames,
    moleWins: totalMoleWins,
    moleGames: totalMoleGames,
  };

  return { table, matches, roleWinRate, alignmentTally };
}

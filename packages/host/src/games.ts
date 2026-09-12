import { type MatchConfig, type SeatId, validateMatchConfig } from "@benchboss/core";
import {
  type Command,
  type GamePlugin,
  type MatchHandle,
  newSession,
  sessionState,
  step,
} from "@benchboss/referee";

export interface SeatAssignment {
  agentId: string;
  principalId: string;
  seat: SeatId;
}

export interface MatchSpec {
  startedAt?: string;
  matchId: string;
  gameId: string;
  seed: string;
  config: MatchConfig;
  assignments: SeatAssignment[];
}

export interface GameBinding {
  handle: MatchHandle<unknown>;
  score(): Record<SeatId, number>;
  // Phase name only — never state. Safe to expose publicly.
  phase(): string;
}

export function createMatchServer(
  // biome-ignore lint/suspicious/noExplicitAny: plugin State is erased at the binding boundary
  plugin: GamePlugin<any>,
  config: MatchConfig,
  seed: string,
): GameBinding {
  const validation = validateMatchConfig(config, {
    gameId: plugin.id,
    manifest: plugin.manifest,
    hasHostEventHandler: typeof plugin.onHostEvent === "function",
  });
  if (!validation.ok) throw Error(validation.reason);
  const game = plugin.makeGame();
  let session = newSession({
    game,
    publicView: plugin.publicView,
    config,
    seed,
    phaseToTools: plugin.phaseToTools,
    currentPhase: plugin.currentPhase,
    isReady: plugin.isReady,
    defaultAction: plugin.safeDefault,
    senseResolvers: plugin.senseResolvers?.(seed),
    participation: plugin.participation,
    onHostEvent: plugin.onHostEvent,
  });
  const handle: MatchHandle<unknown> = {
    get: () => session,
    advance: (cmd: Command) => {
      const r = step(session, cmd);
      session = r.session;
      return r.output;
    },
  };
  return {
    handle,
    score: () => game.score(sessionState(handle.get())) as Record<SeatId, number>,
    phase: () => plugin.currentPhase(sessionState(handle.get())),
  };
}

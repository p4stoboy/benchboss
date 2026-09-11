import type { GameModule, SeatId } from "@benchboss/core";
import type {
  ActionInvocation,
  GameManifest,
  HostEvent,
  Participation,
  SpectatorView,
} from "@benchboss/protocol";
import type { SenseResolver } from "./sense-resolver";

// One self-contained game: the GameModule plus every wiring value the referee's
// `newSession` needs, plus the match defaults the platform uses to size and
// configure a match. `senseResolvers` is a factory because spy's resolvers are
// seeded off the match seed. Heterogeneous instances are held as GamePlugin<any>.
export interface GamePlugin<State> {
  manifest: GameManifest;
  publicView(state: State): SpectatorView;
  id: string;
  // biome-ignore lint/suspicious/noExplicitAny: a plugin is agnostic over Action/Observation/Score
  makeGame(): GameModule<State, any, any, any>;
  phaseToTools: Record<string, string[]>;
  currentPhase(s: State): string;
  isReady(s: State): boolean;
  safeDefault(s: State, seat: SeatId): ActionInvocation;
  senseResolvers?: (seed: string) => SenseResolver<State>[];
  defaultSeats: number;
  participation?: (state: State, seat: SeatId) => Participation;
  onHostEvent?: (state: State, event: HostEvent) => State;
  defaultRules?: Record<string, unknown>;
}

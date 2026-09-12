import { plugin as chess } from "@benchboss/game-chess";
import { plugin as rpsN } from "@benchboss/game-rps-n";
import { plugin as spy } from "@benchboss/game-spy";
import type { GamePlugin } from "@benchboss/referee";

// The enabled game set for this deployment. A renamed or broken plugin fails
// compilation; hosts can select any subset of these implementations.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous game plugins
export const GAMES: GamePlugin<any>[] = [rpsN, spy, chess];

export const CATALOG = GAMES.map((plugin) => ({
  plugin,
  revision: plugin.manifest.revision,
}));

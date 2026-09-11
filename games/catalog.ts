import { plugin as chess } from "@benchboss/game-chess";
import { plugin as rpsN } from "@benchboss/game-rps-n";
import { plugin as spy } from "@benchboss/game-spy";
import type { GamePlugin } from "@benchboss/referee";
import { plugin as legacyRpsN } from "./legacy-v0/rps-n/plugin";
import { plugin as legacySpy } from "./legacy-v0/spy/plugin";

import { plugin as v1Chess } from "./legacy-v1/chess/plugin";
import { plugin as v1RpsN } from "./legacy-v1/rps-n/plugin";
import { plugin as v1Spy } from "./legacy-v1/spy/plugin";

// The enabled game set for this deployment. Compiler-checked: a renamed or
// broken plugin fails the build, not at runtime.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous game plugins
export const GAMES: GamePlugin<any>[] = [rpsN, spy, chess];

// Historical records without identity resolve only to this explicitly retained
// implementation. New entries must never replace a published revision.
export const LEGACY_REVISION = "legacy-v0";
export const CATALOG = [
  ...[legacyRpsN, legacySpy].map((plugin) => ({
    plugin,
    revision: LEGACY_REVISION,
    isLatest: false,
    isLegacy: true,
  })),
  ...[v1RpsN, v1Spy, v1Chess].map((plugin) => ({
    plugin,
    revision: plugin.manifest.revision,
    isLatest: false,
    isLegacy: false,
  })),
  ...GAMES.map((plugin) => ({
    plugin,
    revision: plugin.manifest.revision,
    isLatest: true,
    isLegacy: false,
  })),
];

import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import { CATALOG, GAMES, LEGACY_REVISION } from "../catalog";
import { gameConfig } from "./config";

test("every advertised seat count initializes and defaults progress to explicit terminal outcomes", () => {
  for (const plugin of GAMES) {
    expect(validateSchema(plugin.manifest.rulesSchema, plugin.manifest.defaultRules).ok).toBe(true);
    expect(plugin.manifest.seatCounts).toContain(plugin.defaultSeats);
    if (plugin.manifest.protocolVersion !== 2) throw Error("current catalog must use v2");
    for (const count of plugin.manifest.seatCounts) {
      const seats = Array.from({ length: count }, (_, i) => mkSeatId(i));
      const game = plugin.makeGame();
      let state = game.newMatch(gameConfig(plugin.manifest, "catalog", seats), "catalog-seed");
      for (let guard = 0; guard < 100 && !game.isTerminal(state); guard++) {
        for (const seat of seats) {
          const actions = game.legalActions(state, seat);
          if (!actions.length) continue;
          const fallback = plugin.safeDefault(state, seat);
          const sensing = new Set(
            plugin.senseResolvers?.("catalog-seed").map((resolver) => resolver.tool) ?? [],
          );
          const offer = actions.find(
            (action) =>
              action.tool === fallback.tool &&
              !sensing.has(action.tool) &&
              validateSchema(action.jsonSchema, fallback.input).ok,
          );
          expect(offer).toBeDefined();
          const submitted = game.submit(state, seat, fallback.input, offer?.tool);
          expect(submitted.accepted).toBe(true);
          state = submitted.state;
        }
        if (plugin.isReady(state)) state = game.step(state);
      }
      expect(game.isTerminal(state)).toBe(true);
      expect(plugin.publicView(state).result?.seats).toHaveLength(count);
    }
  }
});

test("catalog preserves distinct explicit legacy and latest revision identities", () => {
  for (const plugin of GAMES) {
    const revisions = CATALOG.filter((entry) => entry.plugin.id === plugin.id);
    expect(new Set(revisions.map((entry) => entry.revision)).size).toBe(revisions.length);
    expect(revisions.filter((entry) => entry.isLatest).map((entry) => entry.revision)).toEqual([
      plugin.manifest.revision,
    ]);
  }
  // Only these games existed before revisions were introduced. A new game must
  // not manufacture legacy execution merely to enter the current catalog.
  for (const gameId of ["rps-n", "safehouse-protocol"]) {
    const current = GAMES.find((plugin) => plugin.id === gameId);
    const legacy = CATALOG.find((entry) => entry.plugin.id === gameId && entry.isLegacy);
    if (!current || !legacy) throw Error(`Missing retained revisions for ${gameId}`);
    expect(legacy.revision).toBe(LEGACY_REVISION);
    expect(legacy.plugin.manifest.revision).toBe(LEGACY_REVISION);
    expect(legacy.isLatest).toBe(false);
    expect(legacy.plugin.makeGame).not.toBe(current.makeGame);
    expect(legacy.plugin.publicView).not.toBe(current.publicView);
  }
});

test("replacing a current implementation cannot replace the retained legacy execution", () => {
  const current = GAMES.find((entry) => entry.id === "rps-n");
  const legacy = CATALOG.find((entry) => entry.isLegacy && entry.plugin.id === "rps-n")?.plugin;
  if (!current || !legacy) throw new Error("missing RPS revisions");
  const original = current.makeGame;
  try {
    current.makeGame = () => {
      throw new Error("new incompatible implementation");
    };
    const seats = [mkSeatId(0), mkSeatId(1)];
    if (!legacy.defaultBudgets) throw Error("missing legacy budgets");
    const state = legacy.makeGame().newMatch(
      {
        matchId: "historical",
        gameId: "rps-n",
        seats,
        rules: { rounds: 1 },
        budgets: legacy.defaultBudgets,
      },
      "historical-seed",
    );
    expect(legacy.currentPhase(state)).toBe("throw");
    expect(legacy.publicView(state).result).toBeNull();
  } finally {
    current.makeGame = original;
  }
});

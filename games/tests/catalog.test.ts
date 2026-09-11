import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import { CATALOG, GAMES, LEGACY_REVISION } from "../catalog";

test("every advertised seat count initializes and defaults progress to explicit terminal outcomes", () => {
  for (const plugin of GAMES) {
    expect(validateSchema(plugin.manifest.rulesSchema, plugin.manifest.defaultRules).ok).toBe(true);
    expect(plugin.manifest.seatCounts).toContain(plugin.defaultSeats);
    expect(plugin.manifest.defaultBudgets).toEqual(plugin.defaultBudgets);
    for (const count of plugin.manifest.seatCounts) {
      const seats = Array.from({ length: count }, (_, i) => mkSeatId(i));
      const game = plugin.makeGame();
      let state = game.newMatch(
        {
          matchId: "catalog",
          gameId: plugin.id,
          seats,
          rules: plugin.manifest.defaultRules,
          budgets: plugin.manifest.defaultBudgets,
        },
        "catalog-seed",
      );
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
    expect(revisions.find((entry) => entry.isLegacy)?.plugin.manifest.revision).toBe(
      LEGACY_REVISION,
    );
    expect(revisions.find((entry) => entry.isLegacy)?.isLatest).toBe(false);
    expect(revisions.find((entry) => entry.isLegacy)?.plugin.makeGame).not.toBe(plugin.makeGame);
    expect(revisions.find((entry) => entry.isLegacy)?.plugin.publicView).not.toBe(
      plugin.publicView,
    );
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

import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import { CATALOG, GAMES } from "../catalog";
import { gameConfig } from "./config";

test("every advertised seat count initializes and defaults progress to explicit terminal outcomes", () => {
  for (const plugin of GAMES) {
    expect(validateSchema(plugin.manifest.rulesSchema, plugin.manifest.defaultRules).ok).toBe(true);
    expect(plugin.manifest.seatCounts).toContain(plugin.defaultSeats);
    if (plugin.manifest.protocolVersion !== 1) throw Error("catalog must use protocol v1");
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
          if (!offer) throw Error("missing default offer");
          const submitted = game.submit(state, seat, fallback.input, offer.tool);
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

test("catalog contains one implementation per game with exact identities", () => {
  expect(CATALOG).toHaveLength(GAMES.length);
  expect(new Set(CATALOG.map((entry) => entry.plugin.id)).size).toBe(CATALOG.length);
  for (const entry of CATALOG) {
    expect(entry.revision).toBe(entry.plugin.manifest.revision);
    expect(entry.plugin.manifest.protocolVersion).toBe(1);
  }
});

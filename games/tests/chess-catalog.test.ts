import { expect, test } from "bun:test";
import { CATALOG, GAMES } from "../catalog";

test("the catalog admits one two-agent chess implementation", () => {
  const chess = GAMES.find((game) => game.id === "chess");
  expect(chess).toBeDefined();
  expect(chess?.manifest.seatCounts).toEqual([2]);
  expect(chess?.manifest.protocolVersion).toBe(1);
  const entries = CATALOG.filter((entry) => entry.plugin.id === "chess");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.revision).toBe(chess?.manifest.revision);
});

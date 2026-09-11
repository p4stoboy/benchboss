import { expect, test } from "bun:test";
import { CATALOG, GAMES } from "../catalog";

test("the current catalog admits two-agent chess with an exact replay revision", () => {
  const chess = GAMES.find((game) => game.id === "chess");
  expect(chess).toBeDefined();
  expect(chess?.manifest.seatCounts).toEqual([2]);
  expect(CATALOG.some((entry) => entry.plugin.id === "chess" && entry.isLegacy)).toBe(false);
  expect(CATALOG.find((entry) => entry.plugin.id === "chess" && entry.isLatest)).toMatchObject({
    revision: "2.0.0",
    isLatest: true,
    isLegacy: false,
  });
});

test("the chess v1 revision remains independently executable after migration", () => {
  const historical = CATALOG.find(
    (entry) => entry.plugin.id === "chess" && entry.revision === "1.0.0",
  );
  const current = GAMES.find((entry) => entry.id === "chess");
  expect(historical?.isLatest).toBe(false);
  expect(historical?.plugin.makeGame).not.toBe(current?.makeGame);
  expect(historical?.plugin.manifest.protocolVersion).toBe(1);
});

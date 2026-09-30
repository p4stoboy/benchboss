import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { createRegistry } from "@benchboss/host";
import { GAMES } from "../catalog";

/**
 * A rules change ships as a new revision. A record made under the previous one names
 * that revision and must be refused by the current catalog instead of re-executing
 * under different rules; its recorded frames are what a replay renders.
 */
test("a record pinned to a superseded battle-royale revision is refused, never replayed under new rules", () => {
  const registry = createRegistry(GAMES);
  const current = registry.buildConfig("m", "battle-royale", [mkSeatId(0), mkSeatId(1)]);
  expect(current.identity.revision).toBe("2.2.0");
  expect(registry.resolve(current).id).toBe("battle-royale");
  const recorded = { ...current, identity: { ...current.identity, revision: "1.0.0" } };
  expect(() => registry.resolve(recorded)).toThrow("plugin identity mismatch");
});

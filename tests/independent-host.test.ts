import { expect, test } from "bun:test";
import { createMatchRunner } from "@benchboss/host";
import { checkGameConformance } from "@benchboss/referee";
import { renderSpectatorView } from "@benchboss/viewer";
import { clockGame } from "../packages/host/tests/fixtures/clock-game";

test("an independent game uses the public host, referee and viewer without platform code", async () => {
  const fixture = clockGame();
  expect(
    checkGameConformance(fixture.plugin, { seeds: ["outside"] }).every((result) => result.ok),
  ).toBe(true);
  let saved = 0;
  const runner = createMatchRunner({
    registry: fixture.registry,
    persist: async () => {
      saved++;
    },
  });
  runner.start(fixture.spec);
  const view = runner.view("m");
  if (!view) throw Error("Expected public view");
  expect(renderSpectatorView(view)).toContain("Choose");
  await runner.submit("p0", "m", "choose", {});
  await runner.submit("p1", "m", "choose", {});
  expect(saved).toBe(1);
});

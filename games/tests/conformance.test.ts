import { expect, test } from "bun:test";
import { checkGameConformance } from "@benchboss/referee";
import { GAMES } from "../catalog";
import { plugin as rps } from "../rps-n/src/plugin";

const seeds = Array.from({ length: 12 }, (_, i) => `acceptance:${i}`);
for (const plugin of GAMES)
  test(`${plugin.id} satisfies the public acceptance contract at every supported seat count`, () => {
    const reports = checkGameConformance(plugin, { seeds });
    expect(reports.filter((r) => !r.ok)).toEqual([]);
  }, 60_000);
test("RPS generated actions and rule variants remain deterministic and replayable", () => {
  const reports = checkGameConformance(rps, {
    seeds,
    rules: [{ rounds: 1 }, { rounds: 5 }],
    choose: (_state, _seat, rng) => ({
      tool: "match.throw",
      input: { throw: rng.pick(["rock", "paper", "scissors"]) },
    }),
  });
  expect(reports.filter((r) => !r.ok)).toEqual([]);
}, 60_000);

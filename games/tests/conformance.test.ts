import { expect, test } from "bun:test";
import { type ConformanceOptions, type GamePlugin, checkGameConformance } from "@benchboss/referee";
import { GAMES } from "../catalog";
import { plugin as rps } from "../rps-n/src/plugin";

const seeds = Array.from({ length: 12 }, (_, i) => `acceptance:${i}`);

// Games whose default matrix is too expensive for the shared catalog gate run a
// reduced matrix here; their own suites sweep every seat count at small rules.
// The harness stringifies the whole session per command, so cost grows with
// commands squared: a 30-seat, 40-round battle-royale match costs ~60s per seed.
interface ReducedMatrix {
  seatCounts: number[];
  options: Partial<ConformanceOptions<unknown>>;
}
const REDUCED: Record<string, ReducedMatrix> = {
  "battle-royale": {
    seatCounts: [2, 5, 12, 30],
    options: { seeds: seeds.slice(0, 4), rules: [{ maxRounds: 8, tilesPerSeat: 9 }] },
  },
};

const matrixFor = (plugin: GamePlugin<unknown>) => {
  const reduced = REDUCED[plugin.id];
  if (!reduced) return { plugin, options: { seeds } };
  for (const count of reduced.seatCounts) expect(plugin.manifest.seatCounts).toContain(count);
  return {
    plugin: { ...plugin, manifest: { ...plugin.manifest, seatCounts: reduced.seatCounts } },
    options: { seeds, ...reduced.options },
  };
};

for (const plugin of GAMES)
  test(`${plugin.id} satisfies the public acceptance contract at every supported seat count`, () => {
    const { plugin: target, options } = matrixFor(plugin);
    const reports = checkGameConformance(target, options);
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

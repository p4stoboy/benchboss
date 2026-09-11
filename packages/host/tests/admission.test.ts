import { describe, expect, test } from "bun:test";
import type { MatchConfig } from "@benchboss/core";
import { verifyPluginReplay } from "@benchboss/referee";
import { createMatchServer } from "../src/games";
import { createMatchRunner } from "../src/runner";
import { clockGame } from "./fixtures/clock-game";

const alteredConfigs = (config: MatchConfig): unknown[] => [
  { ...config, identity: { ...config.identity, revision: "99.0.0" } },
  { ...config, extra: true },
  { ...config, identity: { ...config.identity, extra: true } },
  { ...config, identity: { ...config.identity, runtimeVersion: "unknown" } },
  { ...config, seats: [config.seats[0]] },
  { ...config, rules: [] },
  { ...config, budgets: {} },
];

describe("match admission", () => {
  test("direct construction and replay reject invalid configs before plugin factories run", () => {
    const { plugin, spec, registry } = clockGame();
    let factories = 0;
    const guarded = {
      ...plugin,
      makeGame: () => {
        factories++;
        return plugin.makeGame();
      },
      senseResolvers: (seed: string) => {
        factories++;
        return plugin.senseResolvers?.(seed) ?? [];
      },
    };
    for (const config of alteredConfigs(spec.config)) {
      expect(() => registry.resolve(config as MatchConfig)).toThrow();
      expect(() => createMatchServer(guarded, config as MatchConfig, spec.seed)).toThrow();
      expect(
        verifyPluginReplay({
          plugin: guarded,
          config: config as MatchConfig,
          seed: spec.seed,
          log: [],
        }).ok,
      ).toBe(false);
      expect(factories).toBe(0);
    }
  });

  test("admission does not invoke caller getters before rejecting non-data configuration", () => {
    const { plugin, spec, registry } = clockGame();
    let reads = 0;
    const read = () => {
      reads++;
      return {};
    };
    const configs = [
      Object.defineProperty({ ...spec.config }, "identity", { enumerable: true, get: read }),
      {
        ...spec.config,
        identity: Object.defineProperty({ ...spec.config.identity }, "revision", {
          enumerable: true,
          get: read,
        }),
      },
      {
        ...spec.config,
        rules: { nested: Object.defineProperty({}, "secret", { enumerable: true, get: read }) },
      },
      Object.assign(Object.create({ inherited: true }), spec.config),
    ];
    const runner = createMatchRunner({ registry, now: () => 0, persist: async () => {} });
    for (const config of configs) {
      expect(() => registry.resolve(config)).toThrow();
      expect(() => createMatchServer(plugin, config, spec.seed)).toThrow();
      expect(verifyPluginReplay({ plugin, config, seed: spec.seed, log: [] }).ok).toBe(false);
      expect(() => runner.start({ ...spec, config })).toThrow();
      expect(reads).toBe(0);
    }
  });

  test("matching plain and null-prototype configurations complete and replay exactly", () => {
    for (const nullPrototype of [false, true]) {
      const { plugin, spec, registry } = clockGame();
      const config = nullPrototype
        ? (Object.assign(Object.create(null), spec.config, {
            identity: Object.assign(Object.create(null), spec.config.identity),
            rules: Object.assign(Object.create(null), { nested: [null, { enabled: true }] }),
          }) as MatchConfig)
        : spec.config;
      expect(registry.resolve(config).id).toBe(plugin.id);
      const match = createMatchServer(plugin, config, spec.seed);
      for (const seat of config.seats) match.handle.advance({ kind: "commitDefault", seat });
      const session = match.handle.get();
      expect(session.log.at(-1)?.kind).toBe("match.terminal");
      expect(
        verifyPluginReplay({
          plugin,
          config,
          seed: spec.seed,
          log: session.log,
          publishedResult: plugin.publicView(
            session.state as Parameters<typeof plugin.publicView>[0],
          ).result,
        }),
      ).toEqual({ ok: true });
    }
  });
});

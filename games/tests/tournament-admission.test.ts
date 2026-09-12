import { expect, test } from "bun:test";
import { scheduleTournament } from "@benchboss/core";
import { createRegistry } from "@benchboss/host";
import { plugin } from "../rps-n/src/plugin";

test("scheduled matches are admitted without leaking scheduling metadata into game rules", () => {
  const registry = createRegistry([plugin]);
  const matches = scheduleTournament(
    {
      identity: {
        protocolVersion: 1,
        runtimeVersion: "0.1.0",
        gameId: plugin.id,
        revision: plugin.manifest.revision,
      },
      timing: plugin.manifest.defaultTiming,
      resources: plugin.manifest.defaultResources,
      metering: plugin.manifest.defaultMetering,
    },
    {
      agents: ["first", "second"],
      gameId: plugin.id,
      seedBatch: ["a", "b"],
      rotateSeatsAndRoles: true,
      rules: { rounds: 2 },
    },
  );
  for (const match of matches) {
    expect(registry.resolve(match.config).id).toBe(plugin.id);
    expect(match.config.rules).toEqual({ rounds: 2 });
    expect(match.assignments.map((row) => row.agentId).sort()).toEqual(["first", "second"]);
  }
  expect(matches.map((match) => match.assignments[0]?.agentId)).toEqual(["first", "second"]);
});

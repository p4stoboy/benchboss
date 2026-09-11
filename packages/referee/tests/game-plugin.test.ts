import { describe, expect, test } from "bun:test";
import type { GamePlugin } from "../src/game-plugin";

// A GamePlugin is a plain data+function bundle — this test pins its shape by
// constructing a minimal one and reading every field the registry relies on.
describe("GamePlugin", () => {
  test("exposes id, wiring, and match defaults", () => {
    const plugin: GamePlugin<{ phase: string }> = {
      manifest: {
        protocolVersion: 1,
        id: "stub",
        revision: "1",
        title: "Stub",
        description: "Fixture",
        rulesSource: "fixture",
        seatCounts: [2],
        defaultSeats: 2,
        rulesSchema: {},
        defaultRules: {},
        defaultBudgets: {
          wallClockMsPerDecision: 1000,
          toolCallsPerTurn: 1,
          intelOrScoutPoints: 0,
          simRolloutsPerTurn: 0,
          invalidRetries: 1,
        },
        roundStructure: [],
        winConditions: [],
        safeDefaults: [],
        disclosure: "full-after-terminal",
      },
      publicView: () => ({
        version: 1,
        progress: { phase: "p", label: "Fixture", current: 0, total: null },
        blocks: [],
        result: null,
      }),
      id: "stub",
      makeGame: () =>
        ({
          id: "stub",
          newMatch: () => ({ phase: "p" }),
          observe: () => ({}),
          legalActions: () => [],
          submit: (s: { phase: string }) => ({ accepted: true, state: s }),
          step: (s: { phase: string }) => s,
          isTerminal: () => true,
          score: () => ({}),
          // biome-ignore lint/suspicious/noExplicitAny: stub module for shape test
        }) as any,
      phaseToTools: { p: [] },
      currentPhase: (s) => s.phase,
      isReady: () => true,
      safeDefault: () => ({ tool: "match.pass", input: {} }),
      defaultSeats: 2,
      defaultBudgets: {
        wallClockMsPerDecision: 1000,
        toolCallsPerTurn: 1,
        intelOrScoutPoints: 0,
        simRolloutsPerTurn: 0,
        invalidRetries: 1,
      },
    };
    expect(plugin.id).toBe("stub");
    expect(plugin.defaultSeats).toBe(2);
    expect(plugin.currentPhase({ phase: "x" })).toBe("x");
    expect(plugin.senseResolvers).toBeUndefined();
  });
});

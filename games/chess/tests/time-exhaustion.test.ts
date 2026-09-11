import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import type { CurrentMatchConfig } from "@benchboss/core";
import { plugin } from "../src/plugin";

const config: CurrentMatchConfig = {
  identity: { protocolVersion: 2, runtimeVersion: "0.2.0", gameId: "chess", revision: "2.0.0" },
  matchId: "time-exhaustion",
  gameId: "chess",
  seats: [mkSeatId(0), mkSeatId(1)],
  rules: { maxPlies: 80 },
  resources: {},
  metering: {},
  timing: {
    playerTotalMs: 1000,
    decisionLimitMs: null,
    phaseLimits: {},
    clockVisibility: "public",
  },
};

test("a host time exhaustion ends the game without recording a voluntary resignation", () => {
  const game = plugin.makeGame();
  const state = game.newMatch(config, "time-exhaustion");
  const result = plugin.onHostEvent?.(state, {
    kind: "player_time_exhausted",
    seats: [state.players.white],
    phaseId: "time-exhaustion:0",
    at: 1000,
  });
  expect(result?.outcome).toMatchObject({ winner: "black", reason: "timeout" });
  if (!result) throw Error("missing exhaustion transition");
  expect(game.isTerminal(result)).toBe(true);
  expect(result.moves).toEqual([]);
  expect(game.score(result)).toEqual({ [state.players.white]: 0, [state.players.black]: 1 });
  expect(plugin.publicView(result).result?.cause?.kind).toBe("player_time_exhausted");
});

test("voluntary resignation remains distinct from a host-enforced timeout", () => {
  const game = plugin.makeGame();
  const state = game.newMatch(config, "time-exhaustion");
  const submitted = game.submit(state, state.players.white, {}, "match.resign");
  const result = game.step(submitted.state);
  expect(result.outcome?.reason).toBe("resignation");
  expect(plugin.publicView(result).result?.cause?.kind).toBe("resignation");
});

import { describe, expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import { createRegistry } from "@benchboss/host";
import {
  checkGameConformance,
  decisionId,
  newSession,
  observe,
  publicFrames,
  sessionLog,
  step,
  verifyPluginReplay,
} from "@benchboss/referee";
import { CLASS_IDS } from "../src/classes";
import { plugin } from "../src/plugin";
import type { BrState } from "../src/types";
import { randomOrders } from "./random-orders";

const seats = [mkSeatId(0), mkSeatId(1), mkSeatId(2)];
function session(
  rules: Record<string, unknown> = {},
  timing: Partial<BrState["rules"]> & Record<string, unknown> = {},
) {
  const registry = createRegistry([plugin]);
  const config = registry.buildConfig("br-protocol", "battle-royale", seats);
  config.rules = { ...config.rules, ...rules };
  if (config.timing) Object.assign(config.timing, timing);
  return newSession({
    ...plugin,
    game: plugin.makeGame(),
    config,
    seed: "br-protocol",
    defaultAction: plugin.safeDefault,
  });
}
const loadoutAll = (start: ReturnType<typeof session>) => {
  let current = start;
  for (const seat of seats) {
    const next = step(current, {
      kind: "callTool",
      seat,
      tool: "match.loadout",
      input: { actors: ["ranger", "grunt", "medic"] },
    });
    expect(next.output.ok).toBe(true);
    current = next.session;
  }
  return current;
};

test("the manifest advertises every seat count from two to thirty and a loadout catalog", () => {
  expect(plugin.manifest.seatCounts).toEqual(Array.from({ length: 29 }, (_, i) => i + 2));
  expect(plugin.manifest.roundStructure.map((r) => r.phase)).toEqual(["loadout", "orders"]);
  for (const cls of CLASS_IDS) expect(plugin.manifest.roundStructure[0]?.what).toContain(cls);
});

test("the referee rejects malformed loadouts before metering and moves every seat into orders together", () => {
  const initial = step(session(), { kind: "advanceTime", at: 0 }).session;
  for (const input of [
    null,
    {},
    { actors: [] },
    { actors: ["grunt", "grunt", "grunt", "grunt"] },
    { actors: ["grunt", "grunt", "x"] },
  ]) {
    const result = step(initial, {
      kind: "callTool",
      seat: seats[0] as never,
      tool: "match.loadout",
      input,
    });
    expect(result.output.ok).toBe(false);
    expect(result.session.resources).toEqual(initial.resources);
  }
  expect(
    step(initial, {
      kind: "callTool",
      seat: seats[0] as never,
      tool: "match.orders",
      input: { orders: [] },
    }).output.ok,
  ).toBe(false);
  const started = loadoutAll(initial);
  expect(started.state.phase).toBe("orders");
  for (const seat of seats) {
    const view = observe(started, seat) as {
      participation: { status: string };
      actionOffers: { tool: string }[];
    };
    expect(view.participation.status).toBe("acting");
    expect(view.actionOffers.map((o) => o.tool)).toEqual(["match.orders"]);
  }
});

test("schema-valid but illegal orders spend retries and exhaustion commits the safe default", () => {
  const started = loadoutAll(step(session(), { kind: "advanceTime", at: 0 }).session);
  const seat = seats[0] as never;
  const illegal = { orders: [{ unit: "seat:0/0", moveTo: { x: 999, y: 999 } }] };
  const first = step(started, { kind: "callTool", seat, tool: "match.orders", input: illegal });
  expect(first.output.ok).toBe(false);
  expect(decisionId(first.session, seat)).toBe(decisionId(started, seat));
  const second = step(first.session, {
    kind: "callTool",
    seat,
    tool: "match.orders",
    input: illegal,
  });
  expect(second.output.ok).toBe(false);
  const third = step(second.session, {
    kind: "callTool",
    seat,
    tool: "match.orders",
    input: illegal,
  });
  expect(third.output).toMatchObject({ ok: true, reason: "safe default committed" });
  expect(third.session.state.orders[seat]).toBeDefined();
  expect(sessionLog(third.session).some((e) => e.kind === "action.default")).toBe(true);
  const other = seats[1] as never;
  const accepted = step(started, {
    kind: "callTool",
    seat: other,
    tool: "match.orders",
    input: { orders: [] },
  });
  expect(accepted.output.ok).toBe(true);
  const again = step(accepted.session, {
    kind: "callTool",
    seat: other,
    tool: "match.orders",
    input: { orders: [] },
  });
  expect(again.output.ok).toBe(false);
  expect(again.session.resources).toEqual(accepted.session.resources);
});

test("decision deadlines default every silent team and the round resolves; replay verifies the log", () => {
  let current = loadoutAll(step(session({ maxRounds: 6 }), { kind: "advanceTime", at: 0 }).session);
  const rng = createRng("protocol-orders");
  while (!plugin.makeGame().isTerminal(current.state)) {
    const seat = seats[current.state.round % seats.length] as never;
    if (current.state.orders[seat] === undefined && current.state.teams[seat]?.placement === null) {
      const orders = randomOrders(current.state, seat, rng);
      const submitted = step(current, {
        kind: "callTool",
        seat,
        tool: "match.orders",
        input: orders,
      });
      expect(submitted.output.ok).toBe(true);
      current = submitted.session;
    }
    const round = current.state.round;
    current = step(current, {
      kind: "advanceTime",
      at: (current.runtime.at ?? 0) + 60_000,
    }).session;
    expect(current.state.round === round + 1 || current.state.phase === "terminal").toBe(true);
  }
  const log = sessionLog(current);
  const args = { plugin, config: current.config, seed: "br-protocol", log };
  expect(verifyPluginReplay(args)).toEqual({ ok: true });
  expect(verifyPluginReplay({ ...args, seed: "other" }).ok).toBe(false);
  expect(verifyPluginReplay({ ...args, log: log.slice(0, -1) }).ok).toBe(false);
  const frames = publicFrames(current);
  expect(frames.at(-1)?.view.result?.seats).toHaveLength(3);
  expect(frames.slice(0, -1).every((f) => f.view.result === null)).toBe(true);
});

test("player time exhaustion finishes the seat through the host event path", () => {
  const started = loadoutAll(
    step(session({}, { playerTotalMs: 1_000 }), { kind: "advanceTime", at: 0 }).session,
  );
  const expired = step(started, { kind: "advanceTime", at: 1_000 }).session;
  expect(plugin.makeGame().isTerminal(expired.state)).toBe(true);
  expect(seats.every((seat) => expired.state.teams[seat]?.placement === 1)).toBe(true);
});

describe("generated conformance", () => {
  // The referee harness stringifies the whole session per command, so cost grows with the
  // square of commands; a few seat counts spanning the range stand in for all 29.
  test("the smallest, mid-sized and largest lobbies pass defaults, replay and deterministic frames", () => {
    const sampled = { ...plugin, manifest: { ...plugin.manifest, seatCounts: [2, 5, 12, 30] } };
    const reports = checkGameConformance(sampled, {
      seeds: ["conformance"],
      rules: [{ maxRounds: 8, tilesPerSeat: 9 }],
      maxCommands: 20_000,
    });
    expect(reports.filter((r) => !r.ok)).toEqual([]);
  }, 120_000);

  test("random legal orders conform across seeds and rule variants for small lobbies", () => {
    const small = { ...plugin, manifest: { ...plugin.manifest, seatCounts: [2, 4, 7] } };
    const reports = checkGameConformance(small, {
      seeds: ["alpha", "beta", "gamma"],
      rules: [{ maxRounds: 8 }, { maxRounds: 40, tilesPerSeat: 9 }],
      maxCommands: 20_000,
      choose: (state, seat, rng) =>
        state.phase === "loadout"
          ? {
              tool: "match.loadout",
              input: {
                actors: rng.shuffle(["scout", "grunt", "vanguard", "ranger", "medic"]).slice(0, 3),
              },
            }
          : { tool: "match.orders", input: randomOrders(state, seat, rng) },
    });
    expect(reports.filter((r) => !r.ok)).toEqual([]);
  }, 600_000);
});

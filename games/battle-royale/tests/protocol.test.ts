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

test("the referee rejects malformed loadouts before metering and then offers orders to the first seat only", () => {
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
    const acting = seat === seats[0];
    expect(view.participation.status).toBe(acting ? "acting" : "waiting");
    expect(view.actionOffers.map((o) => o.tool)).toEqual(acting ? ["match.orders"] : []);
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
  expect(third.session.state.turns.map((t) => t.seat)).toEqual([seat]);
  expect(sessionLog(third.session).some((e) => e.kind === "action.default")).toBe(true);
  // A seat that is not acting has no offer: its call is refused without a charge.
  const other = seats[1] as never;
  const early = step(started, {
    kind: "callTool",
    seat: other,
    tool: "match.orders",
    input: { orders: [] },
  });
  expect(early.output.ok).toBe(false);
  expect(early.session.resources).toEqual(started.resources);
  const accepted = step(third.session, {
    kind: "callTool",
    seat: other,
    tool: "match.orders",
    input: { orders: [] },
  });
  expect(accepted.output.ok).toBe(true);
  expect(accepted.session.state.turns.map((t) => t.seat)).toEqual([seat, other]);
  const again = step(accepted.session, {
    kind: "callTool",
    seat: other,
    tool: "match.orders",
    input: { orders: [] },
  });
  expect(again.output.ok).toBe(false);
  expect(again.session.resources).toEqual(accepted.session.resources);
});

test("a decision deadline defaults the silent acting seat and the turn passes on; replay verifies the log", () => {
  let current = loadoutAll(step(session({ maxRounds: 6 }), { kind: "advanceTime", at: 0 }).session);
  const rng = createRng("protocol-orders");
  const actingIn = (s: typeof current) =>
    seats.find(
      (seat) =>
        (observe(s, seat) as { participation: { status: string } }).participation.status ===
        "acting",
    );
  let defaulted = 0;
  while (!plugin.makeGame().isTerminal(current.state)) {
    const seat = actingIn(current) as never;
    expect(seat).toBeDefined();
    expect(
      Object.values(current.runtime.participants).filter((p) => p.status === "acting"),
    ).toHaveLength(1);
    if (rng.int(2)) {
      const orders = randomOrders(current.state, seat, rng);
      const submitted = step(current, {
        kind: "callTool",
        seat,
        tool: "match.orders",
        input: orders,
      });
      expect(submitted.output.ok).toBe(true);
      current = submitted.session;
      expect(current.state.pending).toBeNull();
      continue;
    }
    const turns = current.state.turns.length;
    const round = current.state.round;
    current = step(current, {
      kind: "advanceTime",
      at: (current.runtime.at ?? 0) + plugin.manifest.defaultTiming.decisionLimitMs,
    }).session;
    defaulted += 1;
    // The silent seat's default resolved: its turn is recorded or the round has moved on.
    expect(
      current.state.turns.length === turns + 1 ||
        current.state.round === round + 1 ||
        current.state.phase === "terminal",
    ).toBe(true);
  }
  expect(defaulted).toBeGreaterThan(0);
  expect(sessionLog(current).filter((e) => e.kind === "action.default")).toHaveLength(defaulted);
  const log = sessionLog(current);
  const args = { plugin, config: current.config, seed: "br-protocol", log };
  expect(verifyPluginReplay(args)).toEqual({ ok: true });
  expect(verifyPluginReplay({ ...args, seed: "other" }).ok).toBe(false);
  expect(verifyPluginReplay({ ...args, log: log.slice(0, -1) }).ok).toBe(false);
  const frames = publicFrames(current);
  expect(frames.at(-1)?.view.result?.seats).toHaveLength(3);
  expect(frames.slice(0, -1).every((f) => f.view.result === null)).toBe(true);
});

test("player time runs only for the acting seat; exhaustion finishes it through the host event path", () => {
  const started = loadoutAll(
    step(session({}, { playerTotalMs: 1_000 }), { kind: "advanceTime", at: 0 }).session,
  );
  const first = step(started, { kind: "advanceTime", at: 1_000 }).session;
  expect(first.state.teams[seats[0] as never]?.placement).toBe(3);
  expect(first.state.phase).toBe("orders");
  expect(first.runtime.participants[seats[1] as never]?.status).toBe("acting");
  const second = step(first, { kind: "advanceTime", at: 2_000 }).session;
  expect(plugin.makeGame().isTerminal(second.state)).toBe(true);
  expect(seats.map((seat) => second.state.teams[seat]?.placement)).toEqual([3, 2, 1]);
});

describe("generated conformance", () => {
  // The referee harness stringifies the whole session per command, so cost grows with the
  // square of commands; the two-seat lobby stands in for all 29, and the catalog gate covers
  // every seat count with defaults.
  test("the two-seat lobby passes defaults, replay and deterministic frames", () => {
    const sampled = { ...plugin, manifest: { ...plugin.manifest, seatCounts: [2] } };
    const reports = checkGameConformance(sampled, {
      seeds: ["conformance"],
      rules: [{ maxRounds: 8, tilesPerSeat: 9 }],
      maxCommands: 20_000,
    });
    expect(reports.filter((r) => !r.ok)).toEqual([]);
  }, 120_000);

  test("random legal orders conform across seeds and rule variants for the two-seat lobby", () => {
    const small = { ...plugin, manifest: { ...plugin.manifest, seatCounts: [2] } };
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

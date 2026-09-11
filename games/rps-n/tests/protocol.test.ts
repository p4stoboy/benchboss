import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import {
  decisionId,
  newSession,
  observe,
  publicFrames,
  publicView,
  step,
  verifyPluginReplay,
} from "@benchboss/referee";
import { gameConfig } from "../../tests/config";
import { plugin } from "../src/plugin";

const seats = [mkSeatId(0), mkSeatId(1)];
function session() {
  return newSession({
    game: plugin.makeGame(),
    config: gameConfig(plugin.manifest, "protocol", seats, { rounds: 2 }),
    seed: "private-seed",
    ...plugin,
    defaultAction: plugin.safeDefault,
    safeDefault: () => plugin.safeDefault().input,
  });
}

describe("versioned RPS protocol", () => {
  test("rejects malformed or unauthorized inputs before metering and execution", () => {
    const initial = session();
    for (const input of [null, [], { throw: "banana" }, { throw: "rock", secret: true }]) {
      const result = step(initial, {
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.throw",
        input,
      });
      expect(result.output.ok).toBe(false);
      expect(result.session.state).toEqual(initial.state);
      expect(result.session.budgets).toEqual(initial.budgets);
      expect(decisionId(result.session, mkSeatId(0))).toBe(decisionId(initial, mkSeatId(0)));
    }
    expect(step(initial, { kind: "commitDefault", seat: mkSeatId(99) }).session.state).toEqual(
      initial.state,
    );
    const offers = (
      observe(initial, mkSeatId(0)) as {
        actionOffers: { description: string; jsonSchema: unknown }[];
      }
    ).actionOffers;
    expect(offers[0]?.description).toContain("Privately");
    expect(offers[0]?.jsonSchema).toHaveProperty("additionalProperties", false);
  });

  test("simultaneous commits preserve the other seat decision and repeated phases reset budgets", () => {
    let current = session();
    const first = decisionId(current, mkSeatId(0));
    const other = decisionId(current, mkSeatId(1));
    current = step(current, {
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "rock" },
    }).session;
    expect(decisionId(current, mkSeatId(1))).toBe(other);
    expect(decisionId(current, mkSeatId(0))).not.toBe(first);
    expect(
      step(current, {
        kind: "callTool",
        seat: mkSeatId(0),
        tool: "match.throw",
        input: { throw: "paper" },
      }).session.state,
    ).toEqual(current.state);
    current = step(current, { kind: "commitDefault", seat: mkSeatId(1) }).session;
    expect(current.state.phase).toBe("throw");
    expect(decisionId(current, mkSeatId(0))).not.toBe(first);
    const next = step(current, {
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "paper" },
    });
    expect(next.output.ok).toBe(true);
  });

  test("frames preserve actual public states and hide pending throws", () => {
    let current = session();
    current = step(current, {
      kind: "callTool",
      seat: mkSeatId(0),
      tool: "match.throw",
      input: { throw: "paper" },
    }).session;
    const frames = publicFrames(current);
    expect(frames).toHaveLength(2);
    expect(JSON.stringify(frames)).not.toContain("paper");
    expect(JSON.stringify(frames)).not.toContain("private-seed");
    const initialFrame = frames[0];
    if (!initialFrame) throw new Error("missing initial frame");
    initialFrame.view.blocks.length = 0;
    expect(publicFrames(current)[0]?.view.blocks.length).toBeGreaterThan(0);
    current = step(current, { kind: "commitDefault", seat: mkSeatId(1) }).session;
    expect(JSON.stringify(publicView(current))).toContain("paper");
    for (const seat of seats) current = step(current, { kind: "commitDefault", seat }).session;
    expect(publicView(current).result?.seats[0]?.outcome).toBe("win");
    expect(publicFrames(current).at(-1)?.view).toEqual(publicView(current));
    expect(
      current.log
        .filter((event) => event.kind.startsWith("action."))
        .every((event) => event.payload.tool === "match.throw"),
    ).toBe(true);
    expect(
      verifyPluginReplay({
        plugin,
        config: current.config,
        seed: current.seed,
        log: current.log,
      }).ok,
    ).toBe(true);
    expect(
      verifyPluginReplay({
        plugin,
        config: { ...current.config, rules: { rounds: 99 } },
        seed: current.seed,
        log: current.log,
      }).ok,
    ).toBe(false);
  });
});

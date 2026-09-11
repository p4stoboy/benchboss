import { describe, expect, test } from "bun:test";
import { createPhaseMachine, mkSeatId } from "../src/index";
import type { GameModule, MatchConfig, SeatId } from "../src/index";

type S = { phase: string; pending: number; total: number; cfg: MatchConfig };

const fixture: GameModule<S, { add: number }, unknown, number> = {
  id: "fx",
  newMatch: (cfg) => ({ phase: "collect", pending: 2, total: 0, cfg }),
  observe: (s) => ({ total: s.total }),
  legalActions: () => [{ tool: "match.add", phase: "collect", jsonSchema: {} }],
  submit: (s, _seat, a) => ({
    accepted: true,
    reason: "ok",
    committedActionId: `a${s.pending}`,
    state: { ...s, pending: s.pending - 1, total: s.total + a.add },
  }),
  step: (s) => ({ ...s, phase: "done", pending: 0 }),
  isTerminal: (s) => s.phase === "done",
  score: (s) => ({ [mkSeatId(0)]: s.total }) as Record<SeatId, number>,
};

function machine() {
  return createPhaseMachine<S>(
    fixture,
    { collect: ["match.add"], done: [] },
    (s) => s.phase,
    (s) => s.pending === 0,
  );
}

describe("generic phase machine", () => {
  test("current_reports_game_phase", () => {
    const pm = machine();
    expect(pm.current(fixture.newMatch({} as MatchConfig, "s"))).toBe("collect");
  });

  test("tools_legal_in_returns_phase_tool_list", () => {
    const pm = machine();
    expect(pm.toolsLegalIn("collect")).toEqual(["match.add"]);
    expect(pm.toolsLegalIn("done")).toEqual([]);
  });

  test("collect_rejects_tool_not_legal_in_current_phase", () => {
    const pm = machine();
    const s = fixture.newMatch({} as MatchConfig, "s");
    const res = pm.collect(s, mkSeatId(0), "intel.scan", { add: 1 });
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain("not legal");
  });

  test("collect_routes_legal_tool_into_game_submit", () => {
    const pm = machine();
    const s = fixture.newMatch({} as MatchConfig, "s");
    const res = pm.collect(s, mkSeatId(0), "match.add", { add: 5 });
    expect(res.accepted).toBe(true);
    expect(res.state.total).toBe(5);
  });

  test("ready_is_true_only_when_all_seats_acted", () => {
    const pm = machine();
    let s = fixture.newMatch({} as MatchConfig, "s");
    expect(pm.ready(s)).toBe(false);
    s = pm.collect(s, mkSeatId(0), "match.add", { add: 1 }).state;
    s = pm.collect(s, mkSeatId(1), "match.add", { add: 1 }).state;
    expect(pm.ready(s)).toBe(true);
  });

  test("resolve_delegates_to_game_step", () => {
    const pm = machine();
    const s = fixture.newMatch({} as MatchConfig, "s");
    expect(pm.resolve(s).phase).toBe("done");
  });
});

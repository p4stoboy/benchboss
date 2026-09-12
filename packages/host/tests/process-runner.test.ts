import { expect, test } from "bun:test";
import { join } from "node:path";
import { createProcessMatchRunner } from "../src/process-runner";
import type { MatchArtifact, NextEnvelope } from "../src/runner";
import { clockGame } from "./fixtures/clock-game";

const command = [process.execPath, join(import.meta.dir, "fixtures/fault-worker.ts")];
function setup(options = {}) {
  const f = clockGame();
  const artifacts: MatchArtifact[] = [];
  const cancelled: string[] = [];
  const runner = createProcessMatchRunner(
    {
      registry: f.registry,
      maxHoldMs: 0,
      persist: async (artifact) => {
        artifacts.push(artifact);
      },
      persistAborted: async (abortion) => {
        cancelled.push(abortion.matchId);
      },
    },
    { command, timeoutMs: 1000, ...options },
  );
  const spec = (id: string, fault?: string) => ({
    ...f.spec,
    matchId: id,
    config: {
      ...f.spec.config,
      matchId: id,
      rules: fault ? { fault } : {},
      timing: { ...f.spec.config.timing, decisionLimitMs: 10000 },
    },
    assignments: f.spec.assignments.map((s, index) => ({ ...s, principalId: `${id}:${index}` })),
  });
  const finish = () =>
    Promise.all(runner.list().map((m) => runner.abort(m.matchId, "server_shutdown")));
  return { runner, artifacts, cancelled, spec, finish };
}
function identity(turn: NextEnvelope) {
  if (turn.kind !== "turn") throw Error("expected turn");
  return {
    decisionId: (turn.observation as { decisionId: string }).decisionId,
    requestId: "request",
  };
}

test.each(["exit", "hang", "output", "memory"])(
  "%s in one game cannot stop another match",
  async (fault) => {
    const f = setup({ maxMessageBytes: 65536 });
    try {
      await Promise.all([f.runner.start(f.spec("bad", fault)), f.runner.start(f.spec("good"))]);
      const bad = f.runner.submit("bad:0", "bad", "choose", {});
      expect((await f.runner.submit("good:0", "good", "choose", {})).ok).toBe(true);
      expect((await f.runner.submit("good:1", "good", "choose", {})).ok).toBe(true);
      expect(f.artifacts.map((a) => a.record.id)).toEqual(["good"]);
      await bad;
      expect(f.cancelled).toEqual(["bad"]);
      expect(f.runner.poll("bad:0")).toEqual({
        protocolVersion: 1,
        kind: "match_aborted",
        matchId: "bad",
        reason: "game_error",
      });
    } finally {
      await f.finish();
    }
  },
);

test("terminal request receipts survive worker exit and retention never repeats execution", async () => {
  const f = setup({ retentionMs: 20 });
  try {
    await f.runner.start(f.spec("receipt"));
    const turn = await f.runner.next("receipt:1");
    await f.runner.submit("receipt:0", "receipt", "choose", {});
    const first = await f.runner.submit("receipt:1", "receipt", "choose", {}, identity(turn));
    expect(await f.runner.submit("receipt:1", "receipt", "choose", {}, identity(turn))).toEqual(
      first,
    );
    expect(f.artifacts).toHaveLength(1);
    await Bun.sleep(25);
    await f.runner.reap();
    expect(f.runner.inspect()).toEqual([]);
    expect((await f.runner.submit("receipt:1", "receipt", "choose", {}, identity(turn))).ok).toBe(
      false,
    );
    expect(f.artifacts).toHaveLength(1);
  } finally {
    await f.finish();
  }
});

test("process admission and request caches are bounded", async () => {
  const f = setup({ maxMatches: 1, maxCachedRequests: 1 });
  try {
    await f.runner.start(f.spec("one"));
    await expect(f.runner.start(f.spec("two"))).rejects.toThrow("match_capacity");
    const turn = await f.runner.next("one:0");
    await f.runner.submit("one:0", "one", "inspect", {}, identity(turn));
    expect(
      await f.runner.submit("one:0", "one", "inspect", {}, { ...identity(turn), requestId: "new" }),
    ).toMatchObject({ ok: false, reason: "request_capacity" });
  } finally {
    await f.finish();
  }
});

test("game processes do not inherit server secrets", async () => {
  const prior = process.env.BENCHBOSS_TEST_SECRET;
  process.env.BENCHBOSS_TEST_SECRET = "fixture-only";
  const f = setup();
  try {
    await f.runner.start(f.spec("private", "secret"));
    expect((await f.runner.submit("private:0", "private", "choose", {})).ok).toBe(true);
  } finally {
    // biome-ignore lint/performance/noDelete: restore the exact original process environment
    if (prior === undefined) delete process.env.BENCHBOSS_TEST_SECRET;
    else process.env.BENCHBOSS_TEST_SECRET = prior;
    await f.finish();
  }
});

test("isolated terminal results wait for persistence and retry it without game execution", async () => {
  const f = clockGame();
  let offline = true;
  const artifacts: MatchArtifact[] = [];
  const runner = createProcessMatchRunner(
    {
      registry: f.registry,
      maxHoldMs: 0,
      persist: async (artifact) => {
        if (offline) throw Error("offline");
        artifacts.push(artifact);
      },
    },
    { command },
  );
  await runner.start(f.spec);
  await runner.submit("p0", "m", "choose", {});
  expect(await runner.submit("p1", "m", "choose", {})).toMatchObject({
    ok: false,
    reason: "persistence_pending",
  });
  expect(runner.poll("p0")).toEqual({ protocolVersion: 1, kind: "idle" });
  expect(runner.view("m")).toBeNull();
  expect(artifacts).toHaveLength(0);
  offline = false;
  await runner.reap();
  await runner.reap();
  expect(artifacts).toHaveLength(1);
  expect(runner.poll("p0")).toMatchObject({ kind: "match_over" });
});

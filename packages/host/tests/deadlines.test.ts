import { describe, expect, test } from "bun:test";
import { type MatchArtifact, createMatchRunner } from "../src/runner";
import { clockGame } from "./fixtures/clock-game";

function setup(rounds = 1) {
  const f = clockGame(rounds);
  let time = 0;
  const artifacts: MatchArtifact[] = [];
  const runner = createMatchRunner({
    registry: f.registry,
    now: () => time,
    maxHoldMs: 0,
    persist: async (artifact) => {
      artifacts.push(artifact);
    },
  });
  runner.start(f.spec);
  return {
    ...f,
    runner,
    artifacts,
    at: (value: number) => {
      time = value;
    },
  };
}

describe("decision deadlines", () => {
  test("silent agents default to completion without polling", async () => {
    const f = setup(3);
    for (const time of [1000, 2000, 3000]) {
      f.at(time);
      await f.runner.reap();
    }
    expect(f.runner.list()).toEqual([]);
    expect(f.artifacts).toHaveLength(1);
    expect(f.calls).toHaveLength(6);
  });

  test("submission at expiry cannot beat the periodic reaper", async () => {
    const f = setup();
    f.at(1000);
    expect((await f.runner.submit("p0", "m", "choose", {})).ok).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(f.artifacts[0]?.replayJsonl).not.toContain('"action.submit"');
  });

  test("submission just before expiry is accepted exactly once", async () => {
    const f = setup();
    f.at(999);
    expect((await f.runner.submit("p0", "m", "choose", {})).ok).toBe(true);
    f.at(1000);
    await f.runner.reap();
    expect(f.calls).toHaveLength(2);
  });

  test("polling and successful sensing preserve the original clock", async () => {
    const f = setup();
    const first = f.runner.poll("p0");
    f.at(700);
    expect((await f.runner.submit("p0", "m", "inspect", {})).ok).toBe(true);
    const sensed = f.runner.poll("p0");
    if (first.kind !== "turn" || sensed.kind !== "turn") throw Error("expected turns");
    expect(sensed.deadline).toBe(first.deadline);
    f.at(1000);
    await f.runner.reap();
    expect(f.artifacts).toHaveLength(1);
  });

  test("reaping an old phase cannot default a newly opened repeated phase", async () => {
    const f = setup(2);
    f.at(1000);
    await f.runner.reap();
    expect(f.calls).toHaveLength(2);
    const next = f.runner.poll("p0");
    if (next.kind !== "turn") throw Error("expected next round");
    expect(next.deadline).toBe(2000);
    await f.runner.reap();
    expect(f.calls).toHaveLength(2);
  });

  test("concurrent reapers and expired retries do not duplicate defaults", async () => {
    const f = setup();
    f.at(1000);
    await Promise.all([f.runner.reap(), f.runner.submit("p0", "m", "choose", {}), f.runner.reap()]);
    expect(f.calls).toHaveLength(2);
    expect(f.artifacts).toHaveLength(1);
  });

  test("invalid defaults cancel without disclosing a replay or applying completion effects", async () => {
    const f = clockGame();
    f.plugin.safeDefault = () => ({ tool: "missing", input: {} });
    let time = 0;
    let completions = 0;
    const aborted: unknown[] = [];
    const runner = createMatchRunner({
      registry: f.registry,
      now: () => time,
      persist: async () => {
        throw Error("must not persist a terminal result");
      },
      onComplete: async () => {
        completions++;
      },
      persistAborted: async (record) => {
        aborted.push(record);
      },
    });
    runner.start(f.spec);
    time = 1000;
    await runner.reap();
    expect(runner.poll("p0")).toEqual({
      protocolVersion: 1,
      kind: "match_aborted",
      matchId: "m",
      reason: "game_error",
    });
    expect(runner.view("m")).toBeNull();
    expect(completions).toBe(0);
    expect(aborted).toHaveLength(1);
    expect(JSON.stringify(aborted)).not.toContain("secret");
  });

  test("cancellation waits for successful persistence and retries without game execution", async () => {
    const f = clockGame();
    let offline = true;
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async () => {},
      persistAborted: async () => {
        if (offline) throw Error("offline");
      },
    });
    runner.start(f.spec);
    await expect(runner.abort("m", "server_shutdown")).rejects.toThrow("offline");
    expect(runner.poll("p0").kind).toBe("idle");
    offline = false;
    await runner.reap();
    expect(runner.poll("p0")).toEqual({
      protocolVersion: 1,
      kind: "match_aborted",
      matchId: "m",
      reason: "server_shutdown",
    });
    expect(f.calls).toEqual([]);
  });

  test("an exception while collecting the terminal artifact durably cancels the match", async () => {
    const f = clockGame();
    const makeGame = f.plugin.makeGame;
    let scoreCalls = 0;
    f.plugin.makeGame = () => {
      const game = makeGame();
      return {
        ...game,
        score: (state) => {
          if (++scoreCalls > 1) throw Error("broken terminal serialization");
          return game.score(state);
        },
      };
    };
    const aborted: unknown[] = [];
    const artifacts: unknown[] = [];
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async (artifact) => {
        artifacts.push(artifact);
      },
      persistAborted: async (abortion) => {
        aborted.push(abortion);
      },
    });
    runner.start(f.spec);
    await runner.submit("p0", "m", "choose", {});
    await runner.submit("p1", "m", "choose", {});
    await runner.reap();
    expect(runner.poll("p0")).toEqual({
      protocolVersion: 1,
      kind: "match_aborted",
      matchId: "m",
      reason: "game_error",
    });
    expect(artifacts).toEqual([]);
    expect(aborted).toHaveLength(1);
  });
});

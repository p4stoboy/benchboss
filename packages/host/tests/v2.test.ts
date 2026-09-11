import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type MatchConfig, parseJsonl } from "@benchboss/core";
import { buildLocalServer } from "../src/local";
import { createProcessMatchRunner, createProcessVerifier } from "../src/process-runner";
import { createRegistry } from "../src/registry";
import { type MatchArtifact, createMatchRunner } from "../src/runner";
import { clockGame } from "./fixtures/clock-game";
import { lifecycleGame } from "./fixtures/lifecycle-game";

function setup() {
  const f = lifecycleGame();
  let time = 0;
  const artifacts: MatchArtifact[] = [];
  const runner = createMatchRunner({
    registry: f.registry,
    now: () => time,
    maxHoldMs: 0,
    persist: async (a) => {
      artifacts.push(a);
    },
  });
  runner.start(f.spec);
  return {
    ...f,
    runner,
    artifacts,
    at: (n: number) => {
      time = n;
    },
  };
}
describe("v2 host", () => {
  test("preserves total time across moves, pauses waiting seats and expires at equality", async () => {
    const f = setup();
    expect(f.runner.poll("p1")).toMatchObject({
      protocolVersion: 2,
      kind: "waiting",
      observation: { clock: { remainingMs: 1000, running: false } },
    });
    f.at(400);
    expect((await f.runner.submit("p0", "m", "pass", {})).ok).toBe(true);
    f.at(700);
    expect((await f.runner.submit("p1", "m", "pass", {})).ok).toBe(true);
    expect(f.runner.poll("p0")).toMatchObject({
      kind: "turn",
      deadline: 1300,
      observation: { clock: { remainingMs: 600, running: true } },
    });
    f.at(1300);
    expect((await f.runner.submit("p0", "m", "pass", {})).ok).toBe(false);
    expect(f.artifacts).toHaveLength(1);
    expect(f.artifacts[0]?.replayJsonl).toContain("player_time_exhausted");
  });
  test("worker snapshots cannot consume a finished-seat notification and terminal acknowledgement is separate", async () => {
    const f = setup();
    await f.runner.submit("p0", "m", "finish", {});
    const expected = {
      protocolVersion: 2,
      kind: "seat_finished",
      matchId: "m",
      seat: "seat:0",
      reason: "retired",
    } as const;
    expect(f.runner.poll("p0", { acknowledge: false })).toEqual(expected);
    expect(f.runner.poll("p0", { acknowledge: false })).toEqual(expected);
    expect(f.runner.poll("p0")).toEqual(expected);
    expect(f.runner.poll("p0").kind).toBe("idle");
    await f.runner.submit("p1", "m", "finish", {});
    expect(f.runner.poll("p0")).toMatchObject({ protocolVersion: 2, kind: "match_over" });
  });
  test("public metadata excludes private resource balances and hidden clocks", () => {
    const f = setup();
    const view = f.runner.view("m");
    expect(view).toHaveProperty("clocks");
    expect(view).toHaveProperty("resources");
    expect(JSON.stringify(view)).not.toContain("secrets");

    const privateRunner = createMatchRunner({
      registry: f.registry,
      now: () => 0,
      persist: async () => {},
    });
    privateRunner.start({
      ...f.spec,
      config: {
        ...f.spec.config,
        timing: { ...f.spec.config.timing, clockVisibility: "private" as const },
      },
    });
    expect(privateRunner.view("m")).not.toHaveProperty("clocks");
    expect(privateRunner.list()[0]?.seats.every((s) => s.deadline === null)).toBe(true);
  });
  test("policy admission rejects unknown fields, invalid costs and total time without a handler", () => {
    const f = lifecycleGame();
    for (const patch of [
      { surprise: true },
      { timing: { ...f.spec.config.timing, incrementMs: 2 } },
      { metering: { action: { resource: "missing", cost: 1 } } },
      { resources: { fuel: { amount: -1, reset: "match", visibility: "public" } } },
    ])
      expect(() => f.registry.resolve({ ...f.spec.config, ...patch } as MatchConfig)).toThrow();
    expect(() => createRegistry([{ ...f.plugin, onHostEvent: undefined }])).toThrow();
  });
  test("v2 is latest regardless of legacy insertion order and exact historical identities remain available", () => {
    const f = lifecycleGame();
    const old = clockGame().plugin;
    const legacy = {
      ...old,
      id: f.plugin.id,
      manifest: { ...old.manifest, id: f.plugin.id, revision: "1" },
    };
    const registry = createRegistry([f.plugin, legacy]);
    expect(registry.get("lifecycle").manifest.protocolVersion).toBe(2);
    const historical = {
      ...clockGame().spec.config,
      gameId: "lifecycle",
      identity: {
        protocolVersion: 1 as const,
        runtimeVersion: "0.1.0",
        gameId: "lifecycle",
        revision: "1",
      },
    };
    expect(registry.resolve(historical).manifest.protocolVersion).toBe(1);
  });
  test("concurrent duplicate receipts never renew clocks or debit resources twice", async () => {
    const f = setup();
    const turn = f.runner.poll("p0");
    if (turn.kind !== "turn") throw Error("expected turn");
    const identity = {
      decisionId: (turn.observation as { decisionId: string }).decisionId,
      requestId: "one",
    };
    f.at(400);
    const [a, b] = await Promise.all([
      f.runner.submit("p0", "m", "pass", {}, identity),
      f.runner.submit("p0", "m", "pass", {}, identity),
    ]);
    expect(a).toEqual(b);
    f.at(800);
    expect(await f.runner.submit("p0", "m", "pass", {}, identity)).toEqual(a);
    expect(f.runner.view("m")?.resources?.["seat:0"]?.actions).toBe(99);
    await f.runner.submit("p1", "m", "pass", {});
    f.at(1400);
    await f.runner.reap();
    expect(f.artifacts).toHaveLength(1);
  });
  test("simultaneously active seats expire in one batch independent of assignment order", async () => {
    const f = lifecycleGame();
    const plugin = { ...f.plugin, participation: () => ({ status: "acting" as const }) };
    const registry = createRegistry([plugin]);
    let at = 0;
    const saved: MatchArtifact[] = [];
    const runner = createMatchRunner({
      registry,
      now: () => at,
      persist: async (a) => {
        saved.push(a);
      },
    });
    runner.start({ ...f.spec, assignments: [...f.spec.assignments].reverse() });
    at = 1000;
    await runner.reap();
    const events = parseJsonl(saved[0]?.replayJsonl ?? "").filter((e) => e.kind === "host.event");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      kind: "player_time_exhausted",
      seats: ["seat:0", "seat:1"],
      at: 1000,
    });
  });
  test("a phase with no acting seats expires without polling or agent actions", async () => {
    const f = lifecycleGame();
    const plugin = { ...f.plugin, participation: () => ({ status: "waiting" as const }) };
    const registry = createRegistry([plugin]);
    let at = 0;
    const saved: MatchArtifact[] = [];
    const runner = createMatchRunner({
      registry,
      now: () => at,
      persist: async (a) => {
        saved.push(a);
      },
    });
    runner.start({
      ...f.spec,
      config: {
        ...f.spec.config,
        timing: {
          ...f.spec.config.timing,
          phaseLimits: { choose: { durationMs: 250, close: "deadline" as const } },
        },
      },
    });
    at = 249;
    await runner.reap();
    expect(saved).toHaveLength(0);
    at = 250;
    await runner.reap();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.replayJsonl).toContain("phase_expired");
  });
  test("HTTP and process replay dispatch verify timestamped v2 execution", async () => {
    const f = setup();
    f.at(1000);
    await f.runner.reap();
    const artifact = f.artifacts[0];
    if (!artifact) throw Error("missing artifact");
    const local = buildLocalServer({ registry: f.registry });
    await local.artifacts.save(artifact);
    const response = await local.app.fetch(new Request("http://local/replay/m/verify"));
    expect(await response.json()).toMatchObject({ ok: true });
    const verify = createProcessVerifier({
      command: [process.execPath, join(import.meta.dir, "fixtures/lifecycle-worker.ts")],
    });
    expect(
      await verify({
        config: artifact.record.config,
        seed: artifact.record.seed,
        jsonl: artifact.replayJsonl,
      }),
    ).toMatchObject({ ok: true });
    const tampered = parseJsonl(artifact.replayJsonl);
    const event = tampered.find((e) => e.kind === "host.event");
    if (!event) throw Error("missing expiry");
    event.payload.at = 999;
    expect(
      await verify({
        config: artifact.record.config,
        seed: artifact.record.seed,
        jsonl: tampered.map((e) => JSON.stringify(e)).join("\n"),
      }),
    ).toMatchObject({ ok: false });
  });
  test("HTTP advertises v2 and rejects forged host timing commands", async () => {
    const f = lifecycleGame();
    const local = buildLocalServer({ registry: f.registry });
    local.runner.start(f.spec);
    const caps = await local.app.fetch(new Request("http://local/capabilities"));
    expect(await caps.json()).toMatchObject({
      protocolVersion: 2,
      supportedProtocolVersions: [1, 2],
    });
    const forged = await local.app.fetch(
      new Request("http://local/match/submit", {
        method: "POST",
        headers: { "x-bb-seat": "p0" },
        body: JSON.stringify({
          matchId: "m",
          tool: "pass",
          input: {},
          kind: "advanceTime",
          at: 999999999999999,
        }),
      }),
    );
    expect(forged.status).toBe(400);
    expect(local.runner.poll("p0").kind).toBe("turn");
  });
  test("process clocks use injected host time and retain finished notifications across reap snapshots", async () => {
    const f = lifecycleGame();
    let time = 0;
    const artifacts: MatchArtifact[] = [];
    const runner = createProcessMatchRunner(
      {
        registry: f.registry,
        now: () => time,
        maxHoldMs: 0,
        persist: async (a) => {
          artifacts.push(a);
        },
      },
      { command: [process.execPath, join(import.meta.dir, "fixtures/lifecycle-worker.ts")] },
    );
    try {
      await runner.start(f.spec);
      time = 400;
      expect((await runner.submit("p0", "m", "finish", {})).ok).toBe(true);
      await runner.reap();
      await runner.reap();
      expect(runner.poll("p0")).toMatchObject({ protocolVersion: 2, kind: "seat_finished" });
      await runner.reap();
      expect(runner.poll("p0").kind).toBe("idle");
      time = 1400;
      await runner.reap();
      expect(artifacts).toHaveLength(1);
      expect(runner.poll("p0").kind).toBe("match_over");
    } finally {
      await runner.abort("m", "server_shutdown");
    }
  });
});

test("twenty minutes of clock sampling do not inflate replay commands or frames", async () => {
  const f = lifecycleGame();
  let time = 0;
  const artifacts: MatchArtifact[] = [];
  const runner = createMatchRunner({
    registry: f.registry,
    now: () => time,
    maxHoldMs: 0,
    persist: async (a) => {
      artifacts.push(a);
    },
  });
  runner.start({
    ...f.spec,
    config: { ...f.spec.config, timing: { ...f.spec.config.timing, playerTotalMs: 600000 } },
  });
  let actions = 0;
  for (time = 250; time <= 1200000; time += 250) {
    if (time % 30000 === 0 && time < 1170000) {
      const response = await runner.submit(`p${actions % 2}`, "m", "pass", {});
      expect(response.ok).toBe(true);
      actions++;
    } else await runner.reap();
    if (time === 250) expect(runner.view("m")?.clocks?.["seat:0"]?.remainingMs).toBe(599750);
  }
  const artifact = artifacts[0];
  if (!artifact) throw Error("expected terminal artifact");
  const timeCommands = parseJsonl(artifact.replayJsonl).filter(
    (e) => e.kind === "command" && e.payload.kind === "advanceTime",
  );
  expect(timeCommands.length).toBeLessThanOrEqual(actions + 2);
  expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThan(256 * 1024);
});

test("rejected large inputs cannot poison a process match terminal artifact", async () => {
  const f = lifecycleGame();
  let time = 0;
  const artifacts: MatchArtifact[] = [];
  const aborted: string[] = [];
  const command = [process.execPath, join(import.meta.dir, "fixtures/lifecycle-worker.ts")];
  const runner = createProcessMatchRunner(
    {
      registry: f.registry,
      now: () => time,
      maxHoldMs: 0,
      persist: async (artifact) => {
        artifacts.push(artifact);
      },
      persistAborted: async (abortion) => {
        aborted.push(abortion.reason);
      },
    },
    { command },
  );
  try {
    await runner.start(f.spec);
    const input = { noise: `rejected-payload-${"x".repeat(60000)}` };
    // Every request fits ingress; retaining these rejected bodies would exceed the
    // worker's terminal message limit and turn normal expiry into game_error.
    expect(Buffer.byteLength(JSON.stringify(["missing", input]))).toBeLessThan(65536);
    for (let attempt = 0; attempt < 150; attempt++) {
      const unknown = await runner.submit("p0", "m", "missing", input);
      expect(unknown.ok).toBe(false);
      expect(unknown.reason).not.toBe("match_aborted");
      const malformed = await runner.submit("p0", "m", "pass", input);
      expect(malformed.ok).toBe(false);
      expect(malformed.reason).not.toBe("match_aborted");
    }
    expect(runner.inspect()[0]?.over).toBe(false);
    expect(runner.view("m")?.resources?.["seat:0"]?.actions).toBe(100);
    time = 1000;
    await runner.reap();
    expect(aborted).toEqual([]);
    expect(artifacts).toHaveLength(1);
    expect(runner.poll("p0")).toMatchObject({ protocolVersion: 2, kind: "match_over" });
    const artifact = artifacts[0];
    if (!artifact) throw Error("expected persisted timeout artifact");
    expect(artifact.replayJsonl).toContain("player_time_exhausted");
    expect(artifact.replayJsonl).not.toContain("rejected-payload-");
    expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThan(65536);
    const verify = createProcessVerifier({ command });
    expect(
      await verify({
        config: artifact.record.config,
        seed: artifact.record.seed,
        jsonl: artifact.replayJsonl,
      }),
    ).toMatchObject({ ok: true });
  } finally {
    await runner.abort("m", "server_shutdown");
  }
});

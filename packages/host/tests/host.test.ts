import { describe, expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { SERVER_CAPABILITIES } from "@benchboss/protocol";
import type { GamePlugin } from "@benchboss/referee";
import {
  type MatchArtifact,
  buildLocalServer,
  createMatchRunner,
  createRegistry,
  startLocalServer,
} from "../src/index";
const budgets = {
  wallClockMsPerDecision: 1000,
  toolCallsPerTurn: 10,
  intelOrScoutPoints: 0,
  simRolloutsPerTurn: 0,
  invalidRetries: 2,
};
function fixture() {
  let calls = 0;
  const plugin: GamePlugin<{ done: boolean }> = {
    id: "third-party",
    manifest: {
      protocolVersion: 1,
      id: "third-party",
      revision: "1",
      title: "Independent",
      description: "Custom game",
      rulesSource: "rules",
      seatCounts: [1],
      defaultSeats: 1,
      rulesSchema: { type: "object" },
      defaultRules: {},
      defaultBudgets: budgets,
      roundStructure: [],
      winConditions: [],
      safeDefaults: [],
      disclosure: "full-after-terminal",
    },
    publicView: (s) => ({
      version: 1,
      progress: {
        phase: s.done ? "over" : "choose",
        label: "Pick",
        current: s.done ? 1 : 0,
        total: 1,
      },
      blocks: [{ kind: "text", title: "Public", text: "No secrets" }],
      result: null,
    }),
    makeGame: () => ({
      id: "third-party",
      newMatch: () => ({ done: false }),
      observe: (s, seat) => ({
        matchId: "m",
        phase: s.done ? "over" : "choose",
        seat,
        publicState: {},
        privateState: { secret: "hidden" },
      }),
      legalActions: (s) =>
        s.done
          ? []
          : [
              {
                tool: "choose",
                phase: "choose",
                jsonSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
      submit: (s) => {
        calls++;
        return { accepted: true, reason: "ok", state: { ...s, done: true } };
      },
      step: (s) => s,
      isTerminal: (s) => s.done,
      score: () => ({ [mkSeatId(0)]: 1 }),
    }),
    phaseToTools: { choose: ["choose"], over: [] },
    currentPhase: (s) => (s.done ? "over" : "choose"),
    isReady: () => false,
    safeDefault: () => ({ tool: "choose", input: {} }),
    defaultSeats: 1,
    defaultBudgets: budgets,
  };
  const registry = createRegistry([plugin]);
  const config = registry.buildConfig("m", "third-party", [mkSeatId(0)]);
  if (config.budgets === undefined) throw Error("expected legacy config");
  return {
    plugin,
    registry,
    config,
    calls: () => calls,
    spec: {
      matchId: "m",
      gameId: "third-party",
      seed: "seed",
      config,
      assignments: [{ seat: mkSeatId(0), agentId: "a", principalId: "p" }],
    },
  };
}
describe("independent public host", () => {
  test("custom catalog pins revision and refuses unknown and unmapped legacy execution", () => {
    const f = fixture();
    const identity = f.config.identity;
    if (!identity) throw new Error("missing identity");
    expect(f.registry.resolve(f.config).id).toBe("third-party");
    expect(() =>
      f.registry.resolve({ ...f.config, identity: { ...identity, revision: "missing" } }),
    ).toThrow();
    expect(() => f.registry.resolve({ ...f.config, identity: undefined })).toThrow(
      "legacy revision",
    );
  });
  test("legacy mapping cannot become latest and resolved defaults are independent", () => {
    const f = fixture();
    const legacy = { ...f.plugin, manifest: { ...f.plugin.manifest, revision: "legacy-v0" } };
    const latest = { ...f.plugin, manifest: { ...f.plugin.manifest, revision: "2.0.0" } };
    const registry = createRegistry([f.plugin, latest, legacy], {
      legacyRevisions: { "third-party": "legacy-v0" },
    });
    expect(registry.get("third-party").manifest.revision).toBe("2.0.0");
    expect(registry.resolve({ ...f.config, identity: undefined }).manifest.revision).toBe(
      "legacy-v0",
    );
    const cfg = registry.buildConfig("x", "third-party", [mkSeatId(0)]);
    if (cfg.budgets === undefined) throw Error("expected legacy config");
    cfg.budgets.toolCallsPerTurn = 999;
    cfg.rules.changed = true;
    expect(registry.buildConfig("y", "third-party", [mkSeatId(0)]).budgets?.toolCallsPerTurn).toBe(
      10,
    );
    expect(registry.list()[0]?.manifest.revision).toBe("2.0.0");
    expect(() => registry.buildConfig("x", "third-party", [])).toThrow("seats");
    expect(() =>
      registry.buildConfig("x", "third-party", ["invalid" as ReturnType<typeof mkSeatId>]),
    ).toThrow("seats");
    expect(() => createRegistry([{ ...f.plugin, defaultSeats: 2 }])).toThrow("defaults");
    expect(() =>
      registry.resolve({ ...f.config, rules: [] as unknown as Record<string, unknown> }),
    ).toThrow("rules");
  });
  test("concurrent equal requests execute once and replay after terminal, conflicts and stale decisions fail", async () => {
    const f = fixture();
    const saved: MatchArtifact[] = [];
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async (a) => {
        saved.push(a);
      },
    });
    runner.start(f.spec);
    const next = runner.poll("p");
    if (next.kind !== "turn") throw new Error("expected turn");
    const decisionId = (next.observation as { decisionId: string }).decisionId;
    expect(
      (await runner.submit("p", "m", "choose", {}, { decisionId: "stale", requestId: "stale" }))
        .reason,
    ).toBe("stale_decision");
    const identity = { decisionId, requestId: "one" };
    const [a, b] = await Promise.all([
      runner.submit("p", "m", "choose", {}, identity),
      runner.submit("p", "m", "choose", {}, identity),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    expect(f.calls()).toBe(1);
    expect(saved).toHaveLength(1);
    expect(await runner.submit("p", "m", "choose", {}, identity)).toEqual(a);
    expect((await runner.submit("p", "m", "choose", { different: true }, identity)).reason).toBe(
      "request_conflict",
    );
    expect(JSON.stringify(runner.view("m"))).not.toContain("hidden");
    expect(saved[0]?.record.presentation?.frames.length).toBeGreaterThan(0);
  });
  test("persistence retry cannot execute the accepted terminal action twice", async () => {
    const f = fixture();
    let attempts = 0;
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async () => {
        if (++attempts === 1) throw new Error("offline");
      },
    });
    runner.start(f.spec);
    const next = runner.poll("p");
    if (next.kind !== "turn") throw new Error("turn");
    const identity = {
      decisionId: (next.observation as { decisionId: string }).decisionId,
      requestId: "x",
    };
    expect((await runner.submit("p", "m", "choose", {}, identity)).reason).toBe(
      "persistence_pending",
    );
    expect(runner.inspect()[0]?.finalization).toBe("persistence_failed");
    expect(runner.poll("p").kind).toBe("idle");
    await runner.reap();
    expect(runner.inspect()[0]?.finalization).toBe("complete");
    expect(attempts).toBe(2);
    expect(f.calls()).toBe(1);
  });
  test("completion callback failure is explicit and never repeats side effects", async () => {
    const f = fixture();
    let callbacks = 0;
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async () => {},
      onComplete: async () => {
        callbacks++;
        throw new Error("rating failure");
      },
    });
    runner.start(f.spec);
    await runner.submit("p", "m", "choose", {});
    expect(runner.inspect()[0]?.finalization).toBe("completion_failed");
    await runner.reap();
    expect(callbacks).toBe(1);
    expect(runner.inspect()[0]?.finalization).toBe("completion_failed");
  });
  test("slow persistence in one match cannot block submissions in another", async () => {
    const f = fixture();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began = () => {};
    const entered = new Promise<void>((resolve) => {
      began = resolve;
    });
    const runner = createMatchRunner({
      registry: f.registry,
      persist: async (artifact) => {
        if (artifact.record.id === "m") {
          began();
          await held;
        }
      },
    });
    runner.start(f.spec);
    runner.start({
      ...f.spec,
      matchId: "b",
      config: { ...f.config, matchId: "b" },
      assignments: [{ seat: mkSeatId(0), agentId: "b", principalId: "pb" }],
    });
    const first = runner.submit("p", "m", "choose", {});
    await entered;
    try {
      const second = await Promise.race([
        runner.submit("pb", "b", "choose", {}),
        Bun.sleep(100).then(() => ({ ok: false, reason: "blocked" })),
      ]);
      expect(second.ok).toBe(true);
    } finally {
      release();
      await first;
    }
  });
  test("failed persistence retry cannot prevent another match deadline from advancing", async () => {
    const f = fixture();
    let now = 0;
    const runner = createMatchRunner({
      registry: f.registry,
      now: () => now,
      persist: async (artifact) => {
        if (artifact.record.id === "m") throw new Error("offline");
      },
    });
    runner.start(f.spec);
    await runner.submit("p", "m", "choose", {});
    runner.start({
      ...f.spec,
      matchId: "b",
      config: { ...f.config, matchId: "b" },
      assignments: [{ seat: mkSeatId(0), agentId: "b", principalId: "pb" }],
    });
    runner.poll("pb");
    now = 2000;
    await expect(runner.reap()).rejects.toThrow("offline");
    expect(runner.inspect().find((m) => m.matchId === "b")?.finalization).toBe("complete");
  });
  test("local HTTP rejects nonobjects and serves completed artifacts and verification", async () => {
    const f = fixture();
    const { app, runner } = buildLocalServer({ registry: f.registry });
    runner.start(f.spec);
    for (const body of ["null", "[]", "1", "true"]) {
      const res = await app.fetch(
        new Request("http://local/lobby/enqueue", { method: "POST", body }),
      );
      expect(res.status).toBe(400);
    }
    await runner.submit("p", "m", "choose", {});
    const rec = await app.fetch(new Request("http://local/match/m"));
    expect(rec.status).toBe(200);
    const result = await app.fetch(new Request("http://local/replay/m/verify"));
    expect(await result.json()).toMatchObject({ ok: true });
  });
  test("local lifecycle starts an independent listener and closes it", async () => {
    const f = fixture();
    f.spec.config.budgets.wallClockMsPerDecision = 1;
    const local = startLocalServer({ registry: f.registry, port: 0, reapIntervalMs: 10 });
    try {
      const res = await fetch(`http://127.0.0.1:${local.server.port}/capabilities`);
      expect(res.status).toBe(200);
      local.runner.start(f.spec);
      local.runner.poll("p");
      await Bun.sleep(35);
      expect(local.runner.inspect()[0]?.over).toBe(true);
    } finally {
      local.stop();
    }
  });
  test("local runtime accepts unfamiliar catalog and advertises protocol capabilities", async () => {
    const { registry } = fixture();
    const { app } = buildLocalServer({ registry });
    const caps = await app.fetch(new Request("http://local/capabilities"));
    expect(await caps.json()).toEqual(SERVER_CAPABILITIES);
    const games = await app.fetch(new Request("http://local/games"));
    expect(((await games.json()) as { title: string }[])[0]?.title).toBe("Independent");
    const denied = await app.fetch(
      new Request("http://local/match/next", { method: "POST", body: "{}" }),
    );
    expect(denied.status).toBe(401);
  });
});

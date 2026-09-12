import { expect, test } from "bun:test";
import { parseJsonl } from "@benchboss/core";
import { checkGameConformance, verifyPluginReplay } from "@benchboss/referee";
import { type MatchArtifact, createMatchRunner } from "../src/runner";
import { clockGame } from "./fixtures/clock-game";

test("acceptance checks allow an independent plugin and reject broken defaults and deadlocks", () => {
  const good = clockGame();
  expect(checkGameConformance(good.plugin, { seeds: ["fixture"] }).every((r) => r.ok)).toBe(true);
  const invalid = clockGame();
  invalid.plugin.safeDefault = () => ({ tool: "missing", input: {} });
  expect(checkGameConformance(invalid.plugin, { seeds: ["fixture"] })[0]?.detail).toContain(
    "safe default",
  );
  const stuck = clockGame();
  stuck.plugin.isReady = () => false;
  expect(checkGameConformance(stuck.plugin, { seeds: ["fixture"] })[0]?.detail).toContain(
    "no actionable seats",
  );
});

test("acceptance checks reject invalid outcomes and impure public projections", () => {
  const invalid = clockGame();
  const view = invalid.plugin.publicView;
  invalid.plugin.publicView = (state) => ({ ...view(state), result: null });
  expect(checkGameConformance(invalid.plugin, { seeds: ["fixture"] })[0]?.detail).toContain(
    "terminal outcomes",
  );
  const impure = clockGame();
  const project = impure.plugin.publicView;
  let calls = 0;
  impure.plugin.publicView = (state) => ({
    ...project(state),
    blocks: [{ kind: "text", title: "counter", text: String(calls++) }],
  });
  expect(checkGameConformance(impure.plugin, { seeds: ["fixture"] })[0]?.detail).toContain(
    "different logs or public frames",
  );
});

test("replay verification rejects tampered log and published outcomes even when scores agree", async () => {
  const f = clockGame();
  const artifacts: MatchArtifact[] = [];
  const runner = createMatchRunner({
    registry: f.registry,
    persist: async (a) => {
      artifacts.push(a);
    },
  });
  runner.start(f.spec);
  await runner.submit("p0", "m", "choose", {});
  await runner.submit("p1", "m", "choose", {});
  const artifact = artifacts[0];
  if (!artifact) throw Error("missing artifact");
  const log = parseJsonl(artifact.replayJsonl);
  const args = { plugin: f.plugin, config: f.spec.config, seed: f.spec.seed, log };
  expect(verifyPluginReplay(args).ok).toBe(true);
  expect(verifyPluginReplay({ ...args, publishedResult: null }).ok).toBe(false);
  const terminal = log.at(-1);
  if (!terminal) throw Error("missing terminal event");
  terminal.payload.result = { summary: "Forged winner", seats: [] };
  expect(verifyPluginReplay(args).ok).toBe(false);
});

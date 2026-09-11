import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { artifactOverrides, packPackages, readCandidate, run, writeJson } from "./packages";

const root = resolve(import.meta.dir, "..");
const stage = mkdtempSync(join(tmpdir(), "bb-public-consumer-"));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--packages"))
  throw Error("usage: bun scripts/test-packages.ts [--packages <candidate directory>]");
try {
  const directory = args[1] ? resolve(args[1]) : join(stage, "packs");
  if (!args.length) packPackages(root, directory);
  const candidate = readCandidate(directory);
  const overrides = artifactOverrides(candidate, directory);
  const versionOf = (name: string): string => {
    const pkg = candidate.packages.find((p) => p.name === name);
    if (!pkg) throw Error(`Missing candidate ${name}`);
    return pkg.version;
  };
  const runtime = join(stage, "runtime");
  mkdirSync(runtime);
  writeJson(join(runtime, "package.json"), {
    name: "outside-game-author",
    type: "module",
    dependencies: Object.fromEntries(
      candidate.packages
        .filter((p) => !p.name.startsWith("@benchboss/game"))
        .map((p) => [p.name, p.version]),
    ),
    overrides,
  });
  run(runtime, ["install", "--ignore-scripts"]);
  if (existsSync(join(runtime, "node_modules/@benchboss/games")))
    throw Error("Runtime consumer installed official games");
  writeFileSync(
    join(runtime, "external-game.ts"),
    readFileSync(join(root, "packages/host/tests/fixtures/clock-game.ts"), "utf8").replace(
      'from "../../src/registry"',
      'from "@benchboss/host"',
    ),
  );
  writeFileSync(
    join(runtime, "consumer.ts"),
    `import { clockGame } from "./external-game";
import { createMatchRunner } from "@benchboss/host";
import { checkGameConformance } from "@benchboss/referee";
import { renderSpectatorView } from "@benchboss/viewer";
const f = clockGame();
if (checkGameConformance(f.plugin, { seeds: ["outside"] }).some(r => !r.ok)) throw Error("external game failed");
let saved = 0;
const runner = createMatchRunner({ registry: f.registry, persist: async () => { saved++; } });
runner.start(f.spec);
if (!renderSpectatorView(runner.view("m")!).includes("Choose")) throw Error("viewer failed");
await runner.submit("p0", "m", "choose", {}); await runner.submit("p1", "m", "choose", {});
if (saved !== 1) throw Error("host failed");
console.log("Independent game, host, referee and viewer passed.");\n`,
  );
  process.stdout.write(run(runtime, ["run", "consumer.ts"]));
  const catalog = join(stage, "catalog");
  mkdirSync(catalog);
  writeJson(join(catalog, "package.json"), {
    name: "outside-host",
    type: "module",
    dependencies: {
      "@benchboss/games": versionOf("@benchboss/games"),
      "@benchboss/host": versionOf("@benchboss/host"),
    },
    overrides,
  });
  run(catalog, ["install", "--ignore-scripts"]);
  writeFileSync(
    join(catalog, "consumer.ts"),
    `import { CATALOG, GAMES } from "@benchboss/games";
import { createRegistry } from "@benchboss/host";
if (!GAMES.length || !CATALOG.some(e => e.isLegacy)) throw Error("incomplete catalog");
const registry = createRegistry(CATALOG.map(e => e.plugin), { legacyRevisions: Object.fromEntries(CATALOG.filter(e => e.isLegacy).map(e => [e.plugin.id, e.revision])) });
for (const entry of CATALOG) if (registry.get(entry.plugin.id, entry.revision).manifest.revision !== entry.revision) throw Error("invalid catalog entry");
console.log("Installed current and historical game catalog passed.");\n`,
  );
  process.stdout.write(run(catalog, ["run", "consumer.ts"]));
  const agent = join(stage, "agent");
  mkdirSync(agent);
  writeJson(join(agent, "package.json"), {
    name: "remote-agent",
    type: "module",
    dependencies: { "@benchboss/mcp": overrides["@benchboss/mcp"] },
  });
  run(agent, ["install", "--ignore-scripts"]);
  for (const name of ["games", "core", "host", "referee", "game-spy", "game-rps-n"])
    if (existsSync(join(agent, `node_modules/@benchboss/${name}`)))
      throw Error(`Agent unexpectedly installed ${name}`);
  writeFileSync(
    join(agent, "consumer.ts"),
    `import { createBenchBossClient } from "@benchboss/mcp";
import { toolListing } from "@benchboss/mcp/metadata";
const client = createBenchBossClient({ transport: { async request() { return { ok: true }; } } });
if (!(await client.submit("m", "move", {}, { decisionId: "d", requestId: "r" })).ok || !toolListing().length) throw Error("MCP package failed");
console.log("Installed agent MCP passed without game or referee packages.");\n`,
  );
  process.stdout.write(run(agent, ["run", "consumer.ts"]));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

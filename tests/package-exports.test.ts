import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Manifest, packPackages, readJson, run, writeJson } from "../scripts/packages";

const clients = [
  {
    name: "mcp",
    path: "packages/client",
    consumer: `import { createBenchBossClient, type ClientTransport } from "@benchboss/mcp";
import { toolListing } from "@benchboss/mcp/metadata";
const transport: ClientTransport = { async request() { return {}; } };
const client = createBenchBossClient({ transport });
client.submit("match", "move", null, { decisionId: "d", requestId: "r" });
toolListing();`,
  },
];

test.each(clients)(
  "$name types resolve from the installed tarball without development workspace packages",
  ({ name, consumer }) => {
    const root = resolve(import.meta.dir, "..");
    const dir = mkdtempSync(join(tmpdir(), "bb-package-"));
    try {
      const packs = join(dir, "packs");
      const candidate = packPackages(root, packs);
      const pkg = candidate.packages.find((pkg) => pkg.name === `@benchboss/${name}`);
      if (!pkg) throw Error(`Missing client package ${name}`);
      const project = join(dir, "consumer");
      mkdirSync(project);
      writeJson(join(project, "package.json"), {
        name: "isolated-types-consumer",
        type: "module",
        dependencies: { [pkg.name]: `file:${join(packs, pkg.file)}` },
        devDependencies: {
          "@types/node": readJson<Manifest>(join(root, "node_modules/@types/node/package.json"))
            .version,
        },
      });
      run(project, ["install", "--ignore-scripts"]);
      writeFileSync(join(project, "consumer.ts"), consumer);
      writeJson(join(project, "tsconfig.json"), {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
          lib: ["ESNext", "DOM"],
          types: ["node"],
          skipLibCheck: false,
        },
        include: ["consumer.ts"],
      });
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          "tsconfig.json",
        ],
        { cwd: project, timeout: 50_000 },
      );
      expect({
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

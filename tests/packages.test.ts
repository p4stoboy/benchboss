import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Artifact,
  type Candidate,
  assertTarContents,
  packPackages,
  publishManifest,
  readCandidate,
  selectPackages,
} from "../scripts/packages";

describe("release package boundaries", () => {
  test("strips development dependencies and refuses a private runtime dependency", () => {
    const source = {
      name: "@benchboss/example",
      version: "0.1.0",
      license: "MIT",
      files: ["dist"],
      devDependencies: { "@benchboss/identity": "workspace:*" },
      scripts: { build: "private source" },
    };
    expect(publishManifest(source, [])).toEqual({
      name: source.name,
      version: source.version,
      license: "MIT",
      files: ["dist"],
    });
    expect(() =>
      publishManifest({ ...source, dependencies: { "@benchboss/identity": "workspace:*" } }, [
        {
          dir: "identity",
          manifest: { name: "@benchboss/identity", version: "0.0.0", private: true },
        },
      ]),
    ).toThrow("cannot publish dependency");
  });
  test("rejects credentials, development source and path traversal in actual pack listings", () => {
    assertTarContents(["package/package.json", "package/LICENSE", "package/src/index.ts"]);
    for (const path of [
      "package/.env",
      "package/.env.production",
      "package/.local/password",
      "package/tests/fixture.ts",
      "package/../secret",
      "/etc/passwd",
      "package/server.key",
    ])
      expect(() => assertTarContents([path])).toThrow("Forbidden package file");
  });
  test("release selection rejects unknown names and orders selected dependencies first", () => {
    const make = (name: string, dependencies: Record<string, string> = {}): Artifact => ({
      name,
      version: "0.1.0",
      file: "test.tgz",
      sha256: "",
      integrity: "",
      dependencies,
    });
    const candidate: Candidate = {
      schemaVersion: 1,
      packages: [make("@benchboss/games", { "@benchboss/core": "0.1.0" }), make("@benchboss/core")],
    };
    expect(selectPackages(candidate, "all").map((p) => p.name)).toEqual([
      "@benchboss/core",
      "@benchboss/games",
    ]);
    for (const selection of [
      "",
      "@benchboss/private",
      "../../secret",
      "@benchboss/core,@benchboss/core",
      "$(echo surprise)",
    ])
      expect(() => selectPackages(candidate, selection)).toThrow("Select unique");
  });
});

test("candidate checksums reject modified tarballs before installation", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-candidate-test-"));
  try {
    mkdirSync(join(root, "packages/example/src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    writeFileSync(
      join(root, "packages/example/package.json"),
      JSON.stringify({
        name: "@benchboss/example",
        version: "0.1.0",
        license: "MIT",
        files: ["src", "LICENSE"],
      }),
    );
    writeFileSync(join(root, "packages/example/LICENSE"), "MIT fixture");
    writeFileSync(join(root, "packages/example/src/index.ts"), "export const ready = true;");
    const directory = join(root, "candidate");
    const candidate = packPackages(root, directory);
    expect(readCandidate(directory)).toEqual(candidate);
    const pkg = candidate.packages[0];
    if (!pkg) throw Error("fixture did not pack");
    appendFileSync(join(directory, pkg.file), "tampered");
    expect(() => readCandidate(directory)).toThrow("checksum mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the actual publishing entrypoint blocks non-main and non-CI contexts before reading artifacts", () => {
  const script = resolve(import.meta.dir, "../scripts/publish.ts");
  for (const [actions, ref, blocked] of [
    ["true", "refs/heads/codex/example", true],
    ["false", "refs/heads/main", true],
    ["true", "refs/heads/main", false],
  ] as const) {
    const result = Bun.spawnSync(
      [process.execPath, script, "/nonexistent-benchboss-candidate", "all"],
      {
        env: { ...process.env, GITHUB_ACTIONS: actions, GITHUB_REF: ref },
        timeout: 5000,
      },
    );
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr.toString();
    expect(output.includes("Publication requires")).toBe(blocked);
    if (!blocked) expect(output).toContain("manifest.json");
  }
});

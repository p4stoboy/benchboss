import { beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "dist", "main.js");
const INDEX = join(ROOT, "dist", "index.js");

describe("published bundle", () => {
  beforeAll(() => {
    try {
      execSync("bun run build", { cwd: ROOT, stdio: "pipe", timeout: 90_000 });
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      throw new Error(`bun run build failed:\n${e.stderr ?? e.stdout ?? err}`);
    }
  }, 120_000); // Declaration generation exceeds the default five-second hook limit on CI.

  test("emits the bin and library entrypoints", () => {
    expect(existsSync(MAIN)).toBe(true);
    expect(existsSync(INDEX)).toBe(true);
  });

  test("the bin starts with the node shebang", () => {
    expect(readFileSync(MAIN, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("the bundle contains no supabase or store code", () => {
    const code = readFileSync(MAIN, "utf8");
    expect(code).not.toContain("@supabase");
    expect(code).not.toContain("@benchboss/store");
    const indexCode = readFileSync(INDEX, "utf8");
    expect(indexCode).not.toContain("@supabase");
    expect(indexCode).not.toContain("@benchboss/store");
  });

  test("the real deps stay external", () => {
    const code = readFileSync(MAIN, "utf8");
    expect(code).toContain("@modelcontextprotocol/sdk");
    expect(code).toContain('from "zod"');
  });

  test("package.json declares only sdk and zod as runtime deps", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);
    expect(pkg.bin["benchboss-mcp"]).toBe("./dist/main.js");
    expect(pkg.files).toContain("dist");
  });
});

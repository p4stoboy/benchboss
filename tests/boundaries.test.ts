import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNERSHIP_ROOTS,
  checkBoundaries,
  dependencyViolation,
  moduleSpecifiers,
} from "../scripts/boundaries";

describe("repository boundary guard", () => {
  test("rejects source paths escaping the repository", () => {
    expect(dependencyViolation("src/a.ts", "../another-repo/src", true)).toBeTruthy();
    expect(dependencyViolation("src/a.ts", "src/b", true)).toBeNull();
  });
  test("runtime cannot import games or private packages, including through dev dependencies", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-boundaries-"));
    const put = (path: string, value: string) => writeFileSync(join(dir, path), value);
    try {
      for (const root of OWNERSHIP_ROOTS) mkdirSync(join(dir, root));
      put("packages/package.json", JSON.stringify({ name: "@benchboss/runtime" }));
      put(
        "games/package.json",
        JSON.stringify({
          name: "@benchboss/games",
          dependencies: { "@benchboss/runtime": "workspace:*" },
        }),
      );
      expect(checkBoundaries(dir)).toEqual([]);
      put("packages/forbidden.ts", 'import "@benchboss/games"; import "@benchboss/store";');
      put(
        "games/package.json",
        JSON.stringify({
          name: "@benchboss/games",
          devDependencies: { "@benchboss/store": "0.1.0" },
        }),
      );
      expect(checkBoundaries(dir)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("finds executable and type imports without interpreting comments or ordinary strings", () => {
    expect(
      moduleSpecifiers(`
      // import { ignored } from "@benchboss/store";
      const text = 'from "@benchboss/platform"';
      import type { State } from "@benchboss/core";
      export { runtime } from "@benchboss/host";
      const game = await import("@benchboss/game-spy");
      const platform = require("@benchboss/platform");
      type T = import("@benchboss/registration").T;
    `),
    ).toEqual([
      "@benchboss/core",
      "@benchboss/host",
      "@benchboss/game-spy",
      "@benchboss/platform",
      "@benchboss/registration",
    ]);
  });

  test("finds nested imports, type re-exports, and literal require forms in TSX", () => {
    expect(
      moduleSpecifiers(
        `
      export type { State } from "@benchboss/core";
      export * as host from "@benchboss/host";
      import legacy = require("@benchboss/registration");
      function load() { return import(\`@benchboss/game-spy\`); }
      const cached = require(\`@benchboss/platform\`);
      const view = <div title="import('ignored')" />;
    `,
        "input.tsx",
      ),
    ).toEqual([
      "@benchboss/core",
      "@benchboss/host",
      "@benchboss/registration",
      "@benchboss/game-spy",
      "@benchboss/platform",
    ]);
  });

  test("fails closed when source cannot be parsed", () => {
    expect(() => moduleSpecifiers("import {", "broken.ts")).toThrow("broken.ts:");
  });

  test("handles array holes while still scanning their neighboring imports", () => {
    expect(
      moduleSpecifiers(`
      const [, value] = [null, require("@benchboss/platform")];
      const sparse = [, import("@benchboss/core")];
    `),
    ).toEqual(["@benchboss/platform", "@benchboss/core"]);
  });
});

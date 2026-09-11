import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("public source modules cannot accidentally become npm releases", () => {
  const root = resolve(import.meta.dir, "..");
  const manifests = globSync(
    ["package.json", "packages/*/package.json", "games/package.json", "games/*/package.json"],
    { cwd: root },
  );
  expect(manifests.length).toBeGreaterThan(1);
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    expect({ name: manifest.name, private: manifest.private }).toEqual({
      name: manifest.name,
      private: true,
    });
    expect(manifest.publishConfig).toBeUndefined();
  }
});

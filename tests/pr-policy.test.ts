import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/pr-policy.yml", import.meta.url),
  "utf8",
);
const script = workflow.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");
if (!script) throw Error("Missing PR policy shell script");

describe("the actual PR branch policy workflow", () => {
  test.each([
    ["dev", "codex/change", "p4stoboy/benchboss", true],
    ["dev", "feature/game", "contributor/benchboss", true],
    ["main", "dev", "p4stoboy/benchboss", true],
    ["main", "dev", "contributor/benchboss", false],
    ["main", "codex/change", "p4stoboy/benchboss", false],
    ["dev", "main", "p4stoboy/benchboss", false],
    ["dev", "dev", "p4stoboy/benchboss", false],
    ["release", "codex/change", "p4stoboy/benchboss", false],
    ["main", "dev; exit 0", "p4stoboy/benchboss", false],
  ] as const)("%s <- %s (%s): allowed=%s", (base, head, repository, allowed) => {
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", script], {
      env: {
        BASE_REF: base,
        HEAD_REF: head,
        HEAD_REPO: repository,
        BASE_REPO: "p4stoboy/benchboss",
      },
    });
    expect(result.exitCode === 0).toBe(allowed);
  });
});

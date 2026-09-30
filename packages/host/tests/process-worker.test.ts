import { expect, test } from "bun:test";
import { lifecycleGame } from "./fixtures/lifecycle-game";

test.each([false, true])(
  "post-reply cleanup is opt-in (%s) and runs after flush before the next command",
  async (collect) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/gc-worker.ts", import.meta.url).pathname,
        ...(collect ? ["--collect"] : []),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(
      `${[
        JSON.stringify({ id: 1, payload: { kind: "start", spec: lifecycleGame().spec, at: 0 } }),
        JSON.stringify({ id: 2, payload: { kind: "reap", at: 1 } }),
        JSON.stringify({ id: 3, payload: { kind: "unknown" } }),
        "malformed",
      ].join("\n")}\n`,
    );
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).ok),
    ).toEqual([true, true, false, false]);
    expect(
      stderr.trim()
        ? stderr
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    ).toEqual(
      collect
        ? Array.from({ length: 4 }, (_, i) => ({ force: true, pending: 0, writes: i + 1 }))
        : [],
    );
  },
);

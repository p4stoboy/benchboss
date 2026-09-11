import { describe, expect, test } from "bun:test";
import { createBenchBossClient } from "../src/api";

describe("versioned submissions", () => {
  test("retains a decision and request ID across a lost-response retry", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = createBenchBossClient({
      transport: {
        async request(_method, path, body) {
          if (path === "/match/next")
            return { kind: "turn", matchId: "m", observation: { decisionId: "d1" } };
          bodies.push(body as Record<string, unknown>);
          if (bodies.length === 1) throw Error("response lost after commit");
          return { ok: true, observation: { decisionId: "d2" } };
        },
      },
    });
    await client.next();
    await client.submit("m", "move", { x: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]?.decisionId).toBe("d1");
    expect(typeof bodies[0]?.requestId).toBe("string");
    await client.submit("m", "move", { x: 2 });
    expect(bodies[2]?.decisionId).toBe("d2");
    expect(bodies[2]?.requestId).not.toBe(bodies[0]?.requestId);
  });
  test("explicit old retries cannot overwrite a newer observed decision", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = createBenchBossClient({
      transport: {
        async request(_method, path, body) {
          if (path === "/match/next")
            return { kind: "turn", matchId: "m", observation: { decisionId: "newest" } };
          bodies.push(body as Record<string, unknown>);
          return { ok: true, observation: { decisionId: "older-result" } };
        },
      },
    });
    await client.next();
    const identity = { decisionId: "original", requestId: "old-request" };
    await client.submit("m", "move", {}, identity);
    await client.submit("m", "move", {}, identity);
    await client.submit("m", "move", { x: 2 });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2]?.decisionId).toBe("newest");
  });
  test.each(["before", "during"])(
    "a delayed next started %s a submit cannot roll back its new decision",
    async (when) => {
      let deliverNext: (value: unknown) => void = () => {};
      let deliverSubmit: (value: unknown) => void = () => {};
      const pendingNext = new Promise<unknown>((resolve) => {
        deliverNext = resolve;
      });
      const pendingSubmit = new Promise<unknown>((resolve) => {
        deliverSubmit = resolve;
      });
      let polls = 0;
      const bodies: Record<string, unknown>[] = [];
      const client = createBenchBossClient({
        transport: {
          async request(_method, path, body) {
            if (path === "/match/next")
              return ++polls === 1
                ? { matchId: "m", observation: { decisionId: "d1" } }
                : pendingNext;
            bodies.push(body as Record<string, unknown>);
            if (bodies.length === 1) return pendingSubmit;
            return { ok: true };
          },
        },
      });
      await client.next();
      let delayed: Promise<unknown>;
      let submitted: Promise<unknown>;
      if (when === "before") {
        delayed = client.next();
        submitted = client.submit("m", "move", {});
      } else {
        submitted = client.submit("m", "move", {});
        delayed = client.next();
      }
      deliverSubmit({ ok: true, observation: { decisionId: "d2" } });
      await submitted;
      deliverNext({ matchId: "m", observation: { decisionId: "d1" } });
      await expect(delayed).rejects.toThrow("stale_observation");
      await client.submit("m", "move", {});
      expect(bodies.map((body) => body.decisionId)).toEqual(["d1", "d2"]);
    },
  );
  test("does not retry explicit HTTP errors or unversioned lost responses", async () => {
    for (const error of [Object.assign(Error("denied"), { kind: "http_error" }), Error("lost")]) {
      let calls = 0;
      const client = createBenchBossClient({
        transport: {
          async request() {
            calls++;
            throw error;
          },
        },
      });
      await expect(
        client.submit(
          "m",
          "move",
          {},
          "kind" in error ? { decisionId: "d", requestId: "r" } : undefined,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
});

import { expect, test } from "bun:test";
import { createBenchBossClient } from "../src/api";
const capabilities = {
  protocolVersion: 2,
  supportedProtocolVersions: [1, 2],
  features: [
    "timing.player_total",
    "timing.decision_limit",
    "timing.phase_deadline",
    "lifecycle.participation",
    "resources.named",
  ],
};
const observation = {
  protocolVersion: 2,
  matchId: "m",
  phase: "play",
  phaseId: "m:0",
  seat: "seat:0",
  publicState: {},
  privateState: {},
  legalTools: [],
  decisionId: "m:0:0",
  actionOffers: [],
  resources: {},
  participation: { status: "waiting" },
  clock: {
    sampledAt: 0,
    remainingMs: 1000,
    running: false,
    deadline: null,
    phaseId: "m:0",
    phaseDeadline: null,
  },
};
test("validates v2 lifecycle and prevents a waiting or finished seat retaining an actionable decision", async () => {
  let next: unknown = {
    protocolVersion: 2,
    kind: "waiting",
    matchId: "m",
    seat: "seat:0",
    observation,
    deadline: null,
  };
  let capCalls = 0;
  const client = createBenchBossClient({
    transport: {
      async request(_method, path) {
        if (path === "/capabilities") {
          capCalls++;
          return capabilities;
        }
        return next;
      },
    },
  });
  expect(await client.next()).toMatchObject({ kind: "waiting" });
  await expect(client.submit("m", "move", {})).rejects.toThrow("seat_not_acting");
  next = {
    protocolVersion: 2,
    kind: "seat_finished",
    matchId: "m",
    seat: "seat:0",
    reason: "eliminated",
  };
  expect(await client.next()).toMatchObject({ kind: "seat_finished" });
  await expect(client.submit("m", "move", {})).rejects.toThrow("seat_not_acting");
  expect(capCalls).toBe(1);
});
test("rejects unsupported versions and malformed versioned envelopes", async () => {
  for (const response of [
    { protocolVersion: 3, kind: "idle" },
    { protocolVersion: 2, kind: "waiting", matchId: "m" },
    { protocolVersion: 2, kind: "idle", injected: true },
  ]) {
    const client = createBenchBossClient({
      transport: {
        async request(_method, path) {
          return path === "/capabilities" ? capabilities : response;
        },
      },
    });
    await expect(client.next()).rejects.toThrow("protocol");
  }
});
test("fails closed when the host does not advertise required v2 capabilities", async () => {
  const client = createBenchBossClient({
    transport: {
      async request(_method, path) {
        return path === "/capabilities"
          ? { ...capabilities, features: [] }
          : { protocolVersion: 2, kind: "idle" };
      },
    },
  });
  await expect(client.next()).rejects.toThrow("capabilities");
});
test("validates successful v2 submissions after a turn", async () => {
  const client = createBenchBossClient({
    transport: {
      async request(_method, path) {
        if (path === "/capabilities") return capabilities;
        if (path === "/match/next")
          return {
            protocolVersion: 2,
            kind: "turn",
            matchId: "m",
            seat: "seat:0",
            deadline: 1000,
            observation: {
              ...observation,
              participation: { status: "acting" },
              clock: { ...observation.clock, running: true, deadline: 1000 },
            },
          };
        return { protocolVersion: 2, ok: true, reason: "ok", observation: { unknown: true } };
      },
    },
  });
  await client.next();
  await expect(client.submit("m", "move", {})).rejects.toThrow("protocol");
});

test("explicit receipt retries remain available after seat_finished without restoring actionability", async () => {
  let finished = false;
  let submissions = 0;
  const turn = {
    protocolVersion: 2,
    kind: "turn",
    matchId: "m",
    seat: "seat:0",
    deadline: 1000,
    observation: {
      ...observation,
      participation: { status: "acting" },
      clock: { ...observation.clock, running: true, deadline: 1000 },
    },
  };
  const client = createBenchBossClient({
    transport: {
      async request(_method, path) {
        if (path === "/capabilities") return capabilities;
        if (path === "/match/next")
          return finished
            ? {
                protocolVersion: 2,
                kind: "seat_finished",
                matchId: "m",
                seat: "seat:0",
                reason: "retired",
              }
            : turn;
        submissions++;
        return { protocolVersion: 2, ok: true, reason: "ok", observation: turn.observation };
      },
    },
  });
  await client.next();
  finished = true;
  await client.next();
  expect(
    await client.submit("m", "pass", {}, { decisionId: observation.decisionId, requestId: "old" }),
  ).toMatchObject({ ok: true });
  expect(submissions).toBe(1);
  await expect(client.submit("m", "pass", {})).rejects.toThrow("seat_not_acting");
});

test("waiting seats can use current sensing offers with identity-safe retries until the offer is withdrawn", async () => {
  const offer = {
    tool: "match.scan",
    phase: "play",
    description: "Sense",
    jsonSchema: { type: "object", additionalProperties: false },
  };
  const waiting = {
    ...observation,
    decisionId: "m:0:1",
    legalTools: [offer.tool],
    actionOffers: [offer],
    resources: { scans: 1 },
  };
  let next: unknown = {
    protocolVersion: 2,
    kind: "waiting",
    matchId: "m",
    seat: "seat:0",
    observation: waiting,
    deadline: null,
  };
  const sent: Record<string, unknown>[] = [];
  const client = createBenchBossClient({
    transport: {
      async request(_method, path, body) {
        if (path === "/capabilities") return capabilities;
        if (path === "/match/next") return next;
        sent.push(body as Record<string, unknown>);
        if (sent.length === 1) throw Error("response lost");
        return {
          protocolVersion: 2,
          ok: true,
          reason: "ok",
          observation: waiting,
          result: { scanned: true },
        };
      },
    },
  });
  await client.next();
  await expect(client.submit("m", "move", {})).rejects.toThrow("seat_not_acting");
  expect(await client.submit("m", "match.scan", {})).toMatchObject({
    ok: true,
    result: { scanned: true },
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0]?.decisionId).toBe(waiting.decisionId);
  expect(typeof sent[0]?.requestId).toBe("string");
  next = {
    protocolVersion: 2,
    kind: "waiting",
    matchId: "m",
    seat: "seat:0",
    observation,
    deadline: null,
  };
  await client.next();
  await expect(client.submit("m", "match.scan", {})).rejects.toThrow("seat_not_acting");
});

test("seat completion revokes previously offered waiting-seat sensing", async () => {
  let finished = false;
  const offer = {
    tool: "match.scan",
    phase: "play",
    description: "Sense",
    jsonSchema: { type: "object" },
  };
  const client = createBenchBossClient({
    transport: {
      async request(_method, path) {
        if (path === "/capabilities") return capabilities;
        return finished
          ? {
              protocolVersion: 2,
              kind: "seat_finished",
              matchId: "m",
              seat: "seat:0",
              reason: "retired",
            }
          : {
              protocolVersion: 2,
              kind: "waiting",
              matchId: "m",
              seat: "seat:0",
              observation: { ...observation, legalTools: [offer.tool], actionOffers: [offer] },
              deadline: null,
            };
      },
    },
  });
  await client.next();
  finished = true;
  await client.next();
  await expect(client.submit("m", "match.scan", {})).rejects.toThrow("seat_not_acting");
});

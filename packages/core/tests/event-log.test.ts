import { describe, expect, test } from "bun:test";
import { appendEvent, eventsToJsonl, mkSeatId, parseJsonl } from "../src/index";
import type { LogEvent } from "../src/index";

describe("append-only event log", () => {
  test("append_assigns_monotonic_zero_based_seq", () => {
    let events: readonly LogEvent[] = [];
    events = appendEvent(events, {
      matchId: "m1",
      phase: "throw",
      seat: mkSeatId(0),
      kind: "action.submit",
      payload: { throw: "rock" },
    });
    events = appendEvent(events, {
      matchId: "m1",
      phase: "throw",
      seat: mkSeatId(1),
      kind: "action.submit",
      payload: { throw: "scissors" },
    });
    expect(events[0]?.seq).toBe(0);
    expect(events[1]?.seq).toBe(1);
  });

  test("seq_is_strictly_increasing_across_many_appends", () => {
    let events: readonly LogEvent[] = [];
    const seqs = Array.from({ length: 100 }, (_, i) => {
      events = appendEvent(events, {
        matchId: "m1",
        phase: "p",
        seat: null,
        kind: "k",
        payload: { i },
      });
      // biome-ignore lint/style/noNonNullAssertion: just-appended element exists
      return events[events.length - 1]!.seq;
    });
    for (let i = 1; i < seqs.length; i++)
      // biome-ignore lint/style/noNonNullAssertion: array bounds guaranteed by loop
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
  });

  test("all_returns_events_in_append_order", () => {
    let events: readonly LogEvent[] = [];
    events = appendEvent(events, {
      matchId: "m1",
      phase: "a",
      seat: null,
      kind: "rng.commit",
      payload: { hash: "x" },
    });
    events = appendEvent(events, {
      matchId: "m1",
      phase: "b",
      seat: null,
      kind: "rng.reveal",
      payload: { seed: "y" },
    });
    expect(events.map((e) => e.kind)).toEqual(["rng.commit", "rng.reveal"]);
  });

  test("to_jsonl_is_one_object_per_line_newline_terminated", () => {
    let events: readonly LogEvent[] = [];
    events = appendEvent(events, {
      matchId: "m1",
      phase: "a",
      seat: null,
      kind: "k1",
      payload: {},
    });
    events = appendEvent(events, {
      matchId: "m1",
      phase: "b",
      seat: null,
      kind: "k2",
      payload: {},
    });
    const jsonl = eventsToJsonl(events);
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(jsonl.endsWith("\n")).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    expect(JSON.parse(lines[0]!).seq).toBe(0);
  });

  test("an_empty_log_round_trips_to_an_empty_event_array", () => {
    const events: readonly LogEvent[] = [];
    expect(parseJsonl(eventsToJsonl(events))).toEqual([]);
  });

  test("parse_jsonl_round_trips_to_jsonl", () => {
    let events: readonly LogEvent[] = [];
    events = appendEvent(events, {
      matchId: "m1",
      phase: "a",
      seat: mkSeatId(0),
      kind: "k1",
      payload: { v: 1 },
    });
    events = appendEvent(events, {
      matchId: "m1",
      phase: "b",
      seat: null,
      kind: "k2",
      payload: { v: 2 },
    });
    const parsed: LogEvent[] = parseJsonl(eventsToJsonl(events));
    expect(parsed).toEqual([...events]);
  });
});

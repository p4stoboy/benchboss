import { describe, expect, test } from "bun:test";
import type { SpectatorView } from "@benchboss/protocol";
import { isSpectatorView, renderSpectatorView } from "../src";

const unfamiliar: SpectatorView = {
  version: 1,
  progress: { phase: "auction", label: "Lot 7", current: 7, total: 12 },
  blocks: [
    { kind: "text", title: "Weather", text: "Acid rain" },
    { kind: "metrics", title: "Market", values: [{ label: "Reserve", value: 42 }] },
    { kind: "participants", title: "Bidders", seats: [{ seat: "seat:0", status: "passed" }] },
    { kind: "progress", title: "Lots", current: 7, total: 12 },
    { kind: "table", title: "Bids", columns: ["Seat", "Bid"], rows: [["seat:0", 19]] },
    { kind: "list", title: "History", items: ["opened", "passed"] },
  ],
  result: null,
};

describe("generic spectator renderer", () => {
  test("accepts complete histories and renders every entry without pagination", () => {
    const rows = Array.from({ length: 625 }, (_, i) => [i, `loot-${i}`]);
    const view: SpectatorView = {
      ...unfamiliar,
      blocks: [
        { kind: "table", title: "Loot", columns: ["Entry", "Item"], rows },
        { kind: "list", title: "Chat", items: rows.map((_, i) => `message-${i}`) },
      ],
    };
    expect(isSpectatorView(view)).toBe(true);
    const html = renderSpectatorView(view);
    expect(html.match(/<td>loot-/g)).toHaveLength(rows.length);
    expect(html.match(/<li>message-/g)).toHaveLength(rows.length);
    expect(html).toContain("loot-624");
    expect(html).toContain("message-624");
  });

  test("paginates complete histories without loss, duplication or unescaped later entries", () => {
    const rows = Array.from({ length: 625 }, (_, i) => [i, `<loot-${i}>`]);
    const view: SpectatorView = {
      ...unfamiliar,
      blocks: [
        { kind: "table", title: "Loot", columns: ["Entry", "Item"], rows },
        { kind: "list", title: "Chat", items: rows.map((_, i) => `<message-${i}>`) },
      ],
    };
    const before = structuredClone(view);
    for (const pageSize of [1, 83, 200, 1000]) {
      const seen: number[] = [];
      const messages: number[] = [];
      for (let page = 0; page < Math.ceil(rows.length / pageSize); page++) {
        const html = renderSpectatorView(view, { pageSize, blockPages: { 0: page, 1: page } });
        const entries = [...html.matchAll(/<td>&lt;loot-(\d+)&gt;<\/td>/g)];
        expect(entries.length).toBeLessThanOrEqual(pageSize);
        seen.push(...entries.map((entry) => Number(entry[1])));
        messages.push(
          ...[...html.matchAll(/<li>&lt;message-(\d+)&gt;<\/li>/g)].map((entry) =>
            Number(entry[1]),
          ),
        );
        expect(html).not.toContain("<loot-");
        expect(html).not.toContain("<message-");
      }
      expect(seen).toEqual(rows.map((_, i) => i));
      expect(messages).toEqual(seen);
    }
    expect(view).toEqual(before);
  });

  test("rejects invalid data beyond the visible page and invalid page sizes", () => {
    const rows: unknown[] = Array.from({ length: 625 }, (_, i) => [i]);
    for (const invalid of [[{}], [Number.NaN], [], ["extra", "cell"]]) {
      rows[624] = invalid;
      const view = {
        ...unfamiliar,
        blocks: [{ kind: "table", title: "Loot", columns: ["Item"], rows }],
      };
      expect(isSpectatorView(view)).toBe(false);
      expect(() => renderSpectatorView(view as SpectatorView, { pageSize: 10 })).toThrow(
        "malformed",
      );
    }
    expect(
      isSpectatorView({
        ...unfamiliar,
        blocks: [{ kind: "list", title: "Chat", items: [...Array(624).fill("valid"), {}] }],
      }),
    ).toBe(false);
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => renderSpectatorView(unfamiliar, { pageSize })).toThrow("pageSize");
  });

  test("clamps page selections and leaves empty or short histories without controls", () => {
    const view: SpectatorView = {
      ...unfamiliar,
      blocks: [{ kind: "list", title: '<History "x">', items: ["one", "two", "three"] }],
    };
    const last = renderSpectatorView(view, { pageSize: 2, blockPages: { 0: 999 } });
    expect(last).toContain("<li>three</li>");
    expect(last).not.toContain("<li>one</li>");
    expect(last).toContain('data-view-nav="next" disabled');
    expect(last).toContain('aria-label="&lt;History &quot;x&quot;&gt; pages"');
    for (const page of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const first = renderSpectatorView(view, { pageSize: 2, blockPages: { 0: page } });
      expect(first).toContain("<li>one</li>");
      expect(first).not.toContain("<li>three</li>");
    }
    for (const items of [[], ["one"]]) {
      const html = renderSpectatorView(
        { ...view, blocks: [{ kind: "list", title: "History", items }] },
        { pageSize: 2 },
      );
      expect(html).not.toContain("data-view-page");
    }
  });

  test("renders every shared block without knowing the game", () => {
    const html = renderSpectatorView(unfamiliar);
    for (const text of ["Lot 7", "Acid rain", "Reserve", "Bidders", "Bids", "History"])
      expect(html).toContain(text);
  });

  test("escapes all game-owned text", () => {
    const html = renderSpectatorView({
      ...unfamiliar,
      blocks: [{ kind: "text", title: "<img>", text: "<script>alert('x')</script>" }],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
  });

  test("renders unknown-total progress as a count rather than a falsely complete meter", () => {
    const html = renderSpectatorView({
      ...unfamiliar,
      blocks: [{ kind: "progress", title: "Turns", current: 12, total: null }],
    });
    expect(html).toContain('class="bb-view-count">12<');
    expect(html).not.toContain("<progress");
  });

  test("rejects missing, unknown and unbounded views", () => {
    expect(isSpectatorView(undefined)).toBe(false);
    expect(isSpectatorView({ ...unfamiliar, blocks: [{ kind: "canvas", title: "x" }] })).toBe(
      false,
    );
    expect(
      isSpectatorView({
        ...unfamiliar,
        blocks: Array.from({ length: 101 }, () => unfamiliar.blocks[0]),
      }),
    ).toBe(false);
    expect(() => renderSpectatorView({} as SpectatorView)).toThrow("Unsupported or malformed");
  });
});

test("renders public clock snapshots and arbitrary resource names with escaping", () => {
  const view = {
    ...unfamiliar,
    clocks: {
      "seat:0": {
        sampledAt: 100,
        remainingMs: 12000,
        running: true,
        deadline: 12100,
        phaseId: "m:0",
        phaseDeadline: null,
      },
    },
    resources: { "seat:<1>": { fuel: 9 } },
  };
  const html = renderSpectatorView(view);
  for (const text of ["Clocks", "12000", "running", "Resources", "fuel", "9", "seat:&lt;1&gt;"])
    expect(html).toContain(text);
});
test("rejects malformed public clock or resource metadata", () => {
  for (const extra of [
    { clocks: { "seat:0": { remainingMs: -1 } } },
    { resources: { "seat:0": { fuel: -1 } } },
    { resources: { "seat:0": { fuel: 0.5 } } },
    { resources: { "seat:0": { fuel: Number.MAX_SAFE_INTEGER + 1 } } },
    { resources: { "seat:0": { "": 1 } } },
    { clocks: [] },
  ])
    expect(isSpectatorView({ ...unfamiliar, ...extra })).toBe(false);
});

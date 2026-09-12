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

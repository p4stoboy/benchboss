import { describe, expect, test } from "bun:test";
import { type PublicFrame, type SpectatorBlock, type SpectatorView, foldFrames } from "../src";

/** A small deterministic generator so the property test needs no other package. */
function seededInt(seed: number): (maxExclusive: number) => number {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maxExclusive;
  };
}
const text = (title: string, value: string): SpectatorBlock => ({
  kind: "text",
  title,
  text: value,
});
const view = (blocks: SpectatorBlock[], current = 0): SpectatorView => ({
  version: 1,
  progress: { phase: "play", label: `step ${current}`, current, total: null },
  blocks,
  result: null,
});

/** The reference diff: blocks whose serialised form differs from the folded view so far. */
function delta(previous: SpectatorView | null, next: SpectatorView): SpectatorView {
  if (!previous) return next;
  const before = new Map(previous.blocks.map((b) => [b.title, JSON.stringify(b)]));
  return { ...next, blocks: next.blocks.filter((b) => before.get(b.title) !== JSON.stringify(b)) };
}

describe("foldFrames", () => {
  test("no frames fold to null and a single frame folds to itself", () => {
    expect(foldFrames([])).toBeNull();
    const only = view([text("A", "1")]);
    expect(foldFrames([{ seq: 0, view: only }])).toEqual(only);
  });

  test("a later frame replaces the blocks it names, appends new ones and carries the rest forward", () => {
    const frames: PublicFrame[] = [
      { seq: 0, view: view([text("A", "1"), text("B", "1")]) },
      { seq: 2, view: view([text("B", "2"), text("C", "1")], 1) },
      { seq: 5, view: view([], 2) },
    ];
    expect(foldFrames(frames)).toEqual(view([text("A", "1"), text("B", "2"), text("C", "1")], 2));
    expect(foldFrames(frames, 2)).toEqual(
      view([text("A", "1"), text("B", "2"), text("C", "1")], 1),
    );
    expect(foldFrames(frames, 1)).toEqual(frames[0]?.view ?? null);
    expect(foldFrames(frames, 0)).toBeNull();
  });

  test("progress, result and resources come from the last frame folded even when no block changed", () => {
    const frames: PublicFrame[] = [
      { seq: 0, view: { ...view([text("A", "1")]), resources: { "seat:0": { calls: 1 } } } },
      {
        seq: 1,
        view: {
          ...view([], 1),
          result: {
            summary: "done",
            seats: [{ seat: "seat:0", outcome: "win", placement: 1, metrics: [] }],
          },
          resources: { "seat:0": { calls: 0 } },
        },
      },
    ];
    const folded = foldFrames(frames);
    expect(folded?.blocks).toEqual([text("A", "1")]);
    expect(folded?.progress.current).toBe(1);
    expect(folded?.result?.summary).toBe("done");
    expect(folded?.resources).toEqual({ "seat:0": { calls: 0 } });
  });

  test("a stream of complete frames folds to each frame's own view", () => {
    const frames: PublicFrame[] = [0, 1, 2].map((i) => ({
      seq: i,
      view: view([text("A", String(i)), text("B", "x")], i),
    }));
    for (let count = 1; count <= frames.length; count++)
      expect(foldFrames(frames, count)).toEqual(frames[count - 1]?.view ?? null);
  });

  test("folding the deltas of any view sequence that keeps titles stable reproduces every view", () => {
    const int = seededInt(20260930);
    for (let run = 0; run < 200; run++) {
      const titles = ["A", "B", "C", "D", "E", "F"];
      let present = 1 + int(3);
      const values: Record<string, number> = {};
      const views: SpectatorView[] = [];
      for (let stepIndex = 0; stepIndex < 1 + int(12); stepIndex++) {
        if (present < titles.length && int(4) === 0) present++;
        for (const title of titles.slice(0, present))
          if (int(3) === 0) values[title] = (values[title] ?? 0) + 1;
        views.push(
          view(
            titles.slice(0, present).map((t) => text(t, String(values[t] ?? 0))),
            stepIndex,
          ),
        );
      }
      const frames: PublicFrame[] = [];
      let folded: SpectatorView | null = null;
      views.forEach((next, i) => {
        frames.push({ seq: i, view: delta(folded, next) });
        folded = next;
      });
      views.forEach((expected, i) => expect(foldFrames(frames, i + 1)).toEqual(expected));
      const later = frames.slice(1);
      later.forEach((frame, i) => {
        const before = views[i] as SpectatorView;
        for (const block of frame.view.blocks)
          expect(before.blocks.find((b) => b.title === block.title)).not.toEqual(block);
      });
    }
  });
});

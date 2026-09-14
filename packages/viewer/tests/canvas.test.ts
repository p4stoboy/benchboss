import { describe, expect, test } from "bun:test";
import type { GameRevision, SpectatorView } from "@benchboss/protocol";
import { renderSpectatorView } from "../src";
import { type GameCanvasRenderer, mountCanvasView } from "../src/canvas";

const identity: GameRevision = {
  protocolVersion: 1,
  runtimeVersion: "0.1.0",
  gameId: "fixture",
  revision: "1.0.0",
};
const view = (current = 1): SpectatorView => ({
  version: 1,
  progress: { phase: "play", label: "Public state", current, total: null },
  blocks: [{ kind: "text", title: "Fallback", text: "Visible information" }],
  result: null,
});
const dom = (hasContext = true) => {
  let resize: (() => void) | undefined;
  let width = 200;
  const transforms: number[][] = [];
  const context = { setTransform: (...args: number[]) => transforms.push(args), clearRect() {} };
  const canvas = {
    hidden: false,
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ width }),
    setAttribute() {},
    getContext: () => (hasContext ? context : null),
    remove() {
      canvas.hidden = true;
    },
  };
  const win = {
    devicePixelRatio: 2,
    addEventListener: (_: string, fn: () => void) => {
      resize = fn;
    },
    removeEventListener: () => {
      resize = undefined;
    },
  };
  const host = {
    ownerDocument: { createElement: () => canvas, defaultView: win },
    append() {},
    getBoundingClientRect: () => ({ width }),
  } as unknown as HTMLElement;
  return {
    host,
    canvas,
    transforms,
    resize: () => resize?.(),
    hasListener: () => !!resize,
    setWidth: (next: number) => {
      width = next;
    },
  };
};

const renderer = (
  draw: (view: Readonly<SpectatorView>, width: number) => boolean,
): GameCanvasRenderer => ({
  identity,
  aspectRatio: 1,
  render: (_ctx, view, viewport) => draw(view, viewport.width),
});

describe("canvas of the existing public view", () => {
  test("selects only the exact registered game identity and always keeps HTML available", () => {
    for (const selected of [
      undefined,
      { ...identity, gameId: "other" },
      { ...identity, revision: "2.0.0" },
      { ...identity, protocolVersion: 2 },
      { ...identity, runtimeVersion: "future" },
    ]) {
      const env = dom();
      let draws = 0;
      const current = view();
      const mounted = mountCanvasView(
        env.host,
        [
          renderer(() => {
            draws++;
            return true;
          }),
        ],
        current,
        { identity: selected as GameRevision | undefined },
      );
      expect(draws).toBe(0);
      expect(env.canvas.hidden).toBe(true);
      expect(renderSpectatorView(current)).toContain("Visible information");
      mounted.destroy();
    }
  });
  test("renders arbitrary public snapshots without extra state and isolates recorded input", () => {
    const env = dom();
    const draws: number[] = [];
    const current = view();
    const original = structuredClone(current);
    const mounted = mountCanvasView(
      env.host,
      [
        renderer((snapshot, width) => {
          draws.push(snapshot.progress.current ?? 0);
          expect(snapshot).toEqual(view(snapshot.progress.current ?? 0));
          expect(width).toBe(200);
          snapshot.progress.current = 99;
          snapshot.blocks.length = 0;
          return true;
        }),
      ],
      current,
      { identity },
    );
    mounted.update(view(8));
    mounted.update(current);
    expect(draws).toEqual([1, 8, 1]);
    expect(current).toEqual(original);
    expect(env.canvas.hidden).toBe(false);
    expect(env.canvas.width).toBe(400);
    expect(env.canvas.height).toBe(400);
    expect(env.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    mounted.destroy();
    env.resize();
    mounted.update(view(3));
    expect(draws).toEqual([1, 8, 1]);
    expect(env.hasListener()).toBe(false);
  });
  test("clears stale drawings on errors or false returns and recovers on update and resize", () => {
    const env = dom();
    const widths: number[] = [];
    const mounted = mountCanvasView(
      env.host,
      [
        renderer((snapshot, width) => {
          if (snapshot.progress.current === 2) throw Error("draw failed");
          if (snapshot.progress.current === 4) return false;
          widths.push(width);
          return true;
        }),
      ],
      view(),
      { identity },
    );
    expect(env.canvas.hidden).toBe(false);
    mounted.update(view(2));
    expect(env.canvas.hidden).toBe(true);
    mounted.update(view(3));
    env.setWidth(300);
    env.resize();
    expect(widths).toEqual([200, 200, 300]);
    expect(env.canvas.width).toBe(600);
    mounted.update(view(4));
    expect(env.canvas.hidden).toBe(true);
    mounted.destroy();
  });
  test("uses the existing spectator validator before any game code runs", () => {
    for (const invalid of [
      { ...view(), version: 2 },
      { ...view(), blocks: [{ kind: "unknown" }] },
      { ...view(), blocks: Array(101).fill(view().blocks[0]) },
    ]) {
      const env = dom();
      let draws = 0;
      const mounted = mountCanvasView(
        env.host,
        [
          renderer(() => {
            draws++;
            return true;
          }),
        ],
        invalid as SpectatorView,
        { identity },
      );
      expect(draws).toBe(0);
      expect(env.canvas.hidden).toBe(true);
      mounted.destroy();
    }
  });
  test("does not call a renderer without a context or a usable viewport", () => {
    for (const [hasContext, width, aspectRatio] of [
      [false, 200, 1],
      [true, 0, 1],
      [true, 200, 0],
      [true, 200, Number.NaN],
      [true, 200, 0.001],
    ] as const) {
      const env = dom(hasContext);
      env.setWidth(width);
      let draws = 0;
      const drawing = {
        ...renderer(() => {
          draws++;
          return true;
        }),
        aspectRatio,
      };
      const mounted = mountCanvasView(env.host, [drawing], view(), { identity });
      expect(draws).toBe(0);
      expect(env.canvas.hidden).toBe(true);
      mounted.destroy();
    }
  });
});

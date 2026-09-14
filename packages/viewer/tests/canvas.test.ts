import { describe, expect, test } from "bun:test";
import type { SpectatorView } from "@benchboss/protocol";
import { isSpectatorView, renderSpectatorView } from "../src";
import { type GameCanvasRenderer, isCanvasPresentation, mountCanvasView } from "../src/canvas";

const view = (canvas?: unknown): SpectatorView => ({
  version: 1,
  progress: { phase: "play", label: "Public state", current: 0, total: null },
  blocks: [{ kind: "text", title: "Fallback", text: "Visible information" }],
  result: null,
  ...(canvas === undefined ? {} : { canvas: canvas as SpectatorView["canvas"] }),
});
const payload = (value = 1) => ({ renderer: "fixture", version: 1, state: { value } });
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
  draw: (state: { value: number }, width: number) => void,
): GameCanvasRenderer<{ value: number }> => ({
  id: "fixture",
  version: 1,
  aspectRatio: 1,
  isState: (state): state is { value: number } =>
    typeof state === "object" &&
    state !== null &&
    "value" in state &&
    typeof state.value === "number",
  render: (_ctx, state, viewport) => draw(state, viewport.width),
});

describe("optional canvas presentation", () => {
  test("keeps HTML available for absent, malformed and future canvas payloads", () => {
    const malformed = [
      undefined,
      null,
      {},
      { ...payload(), version: 2 },
      { ...payload(), state: "wrong" },
    ];
    for (const canvas of malformed) {
      const current = view(canvas);
      expect(isSpectatorView(current)).toBe(true);
      expect(renderSpectatorView(current)).toContain("Visible information");
      const env = dom();
      let draws = 0;
      const mounted = mountCanvasView(
        env.host,
        [
          renderer(() => {
            draws++;
          }),
        ],
        current,
      );
      expect(draws).toBe(0);
      expect(env.canvas.hidden).toBe(true);
      mounted.destroy();
    }
  });
  test("draws arbitrary snapshots at device density without mutating recorded state", () => {
    const env = dom();
    const draws: number[] = [];
    const current = view(payload());
    const mounted = mountCanvasView(
      env.host,
      [
        renderer((state, width) => {
          draws.push(state.value);
          expect(width).toBe(200);
          state.value = 99;
        }),
      ],
      current,
    );
    mounted.update(view(payload(8)));
    mounted.update(current);
    expect(draws).toEqual([1, 8, 1]);
    expect(current.canvas?.state).toEqual({ value: 1 });
    expect(env.canvas.width).toBe(400);
    expect(env.canvas.height).toBe(400);
    expect(env.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    mounted.destroy();
    env.resize();
    mounted.update(view(payload(3)));
    expect(draws).toEqual([1, 8, 1]);
    expect(env.hasListener()).toBe(false);
  });
  test("clears stale drawings on failures and redraws after resize or recovery", () => {
    const env = dom();
    const widths: number[] = [];
    const mounted = mountCanvasView(
      env.host,
      [
        renderer((state, width) => {
          if (state.value === 2) throw Error("draw failed");
          widths.push(width);
        }),
      ],
      view(payload()),
    );
    expect(env.canvas.hidden).toBe(false);
    mounted.update(view(payload(2)));
    expect(env.canvas.hidden).toBe(true);
    mounted.update(view(payload(3)));
    env.setWidth(300);
    env.resize();
    expect(widths).toEqual([200, 200, 300]);
    expect(env.canvas.width).toBe(600);
    mounted.update(view());
    expect(env.canvas.hidden).toBe(true);
    mounted.destroy();
  });
  test("does not draw without a 2D context or for unbounded state", () => {
    for (const current of [view(payload()), view({ ...payload(), state: Array(10000).fill(1) })]) {
      const env = dom(false);
      const mounted = mountCanvasView(
        env.host,
        [
          renderer(() => {
            throw Error("unexpected");
          }),
        ],
        current,
      );
      expect(env.canvas.hidden).toBe(true);
      mounted.destroy();
    }
  });
});

test("bounds public canvas input independently of optional context availability", () => {
  expect(isCanvasPresentation(payload())).toBe(true);
  for (const invalid of [
    { ...payload(), renderer: "https://example.com/code.js" },
    { ...payload(), version: 0 },
    { ...payload(), state: Array(10000).fill(1) },
    { ...payload(), state: Number.POSITIVE_INFINITY },
    { ...payload(), state: { missing: undefined } },
  ])
    expect(isCanvasPresentation(invalid)).toBe(false);
});

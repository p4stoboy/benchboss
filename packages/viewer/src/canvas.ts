/// <reference lib="dom" />
import type { CanvasPresentation, JsonValue, SpectatorView } from "@benchboss/protocol";

/** Host-owned styling; never recorded in game state or replay frames. */
export interface CanvasTheme {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  light: string;
  dark: string;
  accent: string;
  danger: string;
  fontFamily: string;
}
export const DEFAULT_CANVAS_THEME: Readonly<CanvasTheme> = {
  background: "#171717",
  surface: "#303030",
  surfaceAlt: "#707070",
  text: "#ededed",
  light: "#fafafa",
  dark: "#171717",
  accent: "#b5b5b5",
  danger: "#d94a4a",
  fontFamily: "monospace",
};
export interface CanvasViewport {
  width: number;
  height: number;
  theme?: Readonly<CanvasTheme>;
}

/** Browser-only companion to a game's publicView projector. */
export interface GameCanvasRenderer<State> {
  id: string;
  version: number;
  aspectRatio: number;
  isState(value: unknown): value is State;
  /** Draw a complete snapshot in CSS pixels, with no dependence on previous draws. */
  render(ctx: CanvasRenderingContext2D, state: State, viewport: Readonly<CanvasViewport>): void;
}

export function isCanvasPresentation(value: unknown): value is CanvasPresentation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (
    typeof data.renderer !== "string" ||
    !/^[a-z0-9][a-z0-9._/-]{0,79}$/.test(data.renderer) ||
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 1
  )
    return false;
  let remaining = 4096;
  const isJson = (item: unknown, depth: number): item is JsonValue => {
    if (--remaining < 0 || depth > 12) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 16384;
    if (Array.isArray(item))
      return item.length <= 4096 && item.every((child) => isJson(child, depth + 1));
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) return false;
    const entries = Object.entries(item);
    return (
      entries.length <= 4096 &&
      entries.every(([key, child]) => key.length <= 128 && isJson(child, depth + 1))
    );
  };
  return isJson(data.state, 0);
}

export interface CanvasView {
  update(view: SpectatorView): void;
  destroy(): void;
}

/** The host keeps the textual view mounted alongside this optional canvas. */
export function mountCanvasView(
  host: HTMLElement,
  renderers: readonly GameCanvasRenderer<unknown>[],
  initial: SpectatorView,
  options: { theme?: () => CanvasTheme } = {},
): CanvasView {
  const canvas = host.ownerDocument.createElement("canvas");
  canvas.hidden = true;
  canvas.style.width = "100%";
  // All information remains in the adjacent accessible HTML view.
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const win = host.ownerDocument.defaultView;
  let view = initial;
  let destroyed = false;
  const draw = () => {
    if (destroyed) return;
    canvas.hidden = true;
    try {
      if (!isCanvasPresentation(view.canvas)) return;
      const payload = view.canvas;
      const renderer = renderers.find(
        (entry) => entry.id === payload.renderer && entry.version === payload.version,
      );
      if (!renderer || !Number.isFinite(renderer.aspectRatio) || renderer.aspectRatio <= 0) return;
      const state: unknown = structuredClone(payload.state);
      if (!renderer.isState(state)) return;
      // Measure the canvas's CSS content width, including when the host has padding.
      canvas.hidden = false;
      const width = Math.min(4096, canvas.getBoundingClientRect().width);
      canvas.hidden = true;
      const height = width / renderer.aspectRatio;
      if (
        !Number.isFinite(width) ||
        width <= 0 ||
        !Number.isFinite(height) ||
        height <= 0 ||
        height > 4096
      )
        return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const ratio = Math.max(1, Math.min(3, win?.devicePixelRatio || 1));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      renderer.render(context, state, {
        width,
        height,
        theme: options.theme?.() ?? DEFAULT_CANVAS_THEME,
      });
      canvas.hidden = false;
    } catch {
      // Optional drawing must never take down the host's textual spectator view.
      canvas.hidden = true;
    }
  };
  win?.addEventListener("resize", draw);
  host.ownerDocument.fonts?.addEventListener("loadingdone", draw);
  draw();
  return {
    update(next) {
      view = next;
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win?.removeEventListener("resize", draw);
      host.ownerDocument.fonts?.removeEventListener("loadingdone", draw);
      canvas.remove();
    },
  };
}

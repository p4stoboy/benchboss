/// <reference lib="dom" />
import type { GameRevision, SpectatorView } from "@benchboss/protocol";
import { isSpectatorView } from "./index";

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
export interface GameCanvasRenderer {
  identity: Readonly<GameRevision>;
  aspectRatio: number;
  /** Draw the existing public snapshot in CSS pixels. False keeps the HTML fallback. */
  render(
    ctx: CanvasRenderingContext2D,
    view: Readonly<SpectatorView>,
    viewport: Readonly<CanvasViewport>,
  ): boolean;
}

export interface CanvasView {
  update(view: SpectatorView): void;
  destroy(): void;
}

/** The host keeps the textual view mounted alongside this optional canvas. */
export function mountCanvasView(
  host: HTMLElement,
  renderers: readonly GameCanvasRenderer[],
  initial: SpectatorView,
  options: { identity: GameRevision | undefined; theme?: () => CanvasTheme },
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
      const identity = options.identity;
      if (!identity || !isSpectatorView(view)) return;
      const renderer = renderers.find(
        ({ identity: supported }) =>
          supported.protocolVersion === identity.protocolVersion &&
          supported.runtimeVersion === identity.runtimeVersion &&
          supported.gameId === identity.gameId &&
          supported.revision === identity.revision,
      );
      if (!renderer || !Number.isFinite(renderer.aspectRatio) || renderer.aspectRatio <= 0) return;
      const snapshot = structuredClone(view);
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
      const rendered = renderer.render(context, snapshot, {
        width,
        height,
        theme: options.theme?.() ?? DEFAULT_CANVAS_THEME,
      });
      canvas.hidden = rendered !== true;
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

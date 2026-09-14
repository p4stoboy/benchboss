# Spectator viewer

`renderSpectatorView(view)` validates and escapes the shared HTML blocks. It runs
without DOM APIs and remains the portable fallback for every game and replay.

## Optional canvas

An optional canvas draws the same `SpectatorView` already returned by `publicView`
and stored in replay frames. No additional state, wire field or canvas schema is
required or supported. A game exports a `GameCanvasRenderer` from a separate
browser-only package subpath; the host explicitly registers it alongside HTML:

```ts
import { mountCanvasView } from "@benchboss/viewer/canvas";
import { chessCanvas } from "@benchboss/game-chess/canvas";

const canvas = mountCanvasView(container, [chessCanvas], view, {
  identity: presentation.identity, // Existing match/replay GameRevision.
});
canvas.update(nextView); // Same path for live updates and replay seeking.
canvas.destroy(); // On navigation/unmount.
```

The renderer supplies its supported `identity: GameRevision`, a positive finite
`aspectRatio` and synchronous `render(ctx, view, {width, height, theme}): boolean`.
Return true after drawing a complete snapshot, or false when the existing public
view cannot be drawn. Game-specific interpretation stays inside the renderer;
Chess reads its existing FEN and UCI blocks. There is no separate renderer version
or generic state validator. Compatibility follows the existing game revision.

The mount matches the complete identity, reuses `isSpectatorView`, clones the view
for each draw and owns canvas sizing, pixel density, resize and disposal. Use the
recorded match/replay identity, not the current catalog revision for historical
matches. Missing identity, unsupported revision, invalid views, false returns,
missing contexts or exceptions hide only the canvas. HTML stays available.

Add `theme: () => palette` to the mount options to supply `CanvasTheme` from host
design tokens. It is read on each draw; call `update` after a theme change. Theme
and font choices never enter persisted game state. Each render must be independent
of earlier frames, use CSS pixels and avoid input mutation, network requests and
timers. Renderer code is trusted bundled code, never loaded from public data. The
root viewer export does not import browser code or game renderers.

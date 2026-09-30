# Spectator viewer

`renderSpectatorView(view)` validates and escapes the shared HTML blocks. It runs
without DOM APIs and remains the portable fallback for every game and replay.

Table and list histories are validated in full regardless of length. To bound
rendered rows/items, pass `{ pageSize: 100, blockPages: { 2: 1 } }`: this selects
the second page of block 2 and the first page of other histories. Omit options
to render all entries. Invalid page sizes throw; missing/invalid page indices
start at zero and indices beyond the history clamp to its last page.

Paged blocks include first/previous/next/last buttons. Hosts handle clicks using
the numeric `data-view-block` and `data-view-page` attributes, update their page
map and render again. `data-view-nav` identifies the control for focus restoration.
The host owns event listeners, styling and disposal. Page state stays outside the
recorded view, and malformed off-page entries still fail validation.

## Optional canvas

An optional canvas draws the same `SpectatorView` already returned by `publicView`
and folded from replay frames (`foldFrames`). No additional state, wire field or canvas schema is
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
and font choices never enter persisted game state. Each render takes a complete
view (the host folds recorded frames before calling it) and must be independent
of earlier renders, use CSS pixels and avoid input mutation, network requests and
timers. Renderer code is trusted bundled code, never loaded from public data. The
root viewer export does not import browser code or game renderers.

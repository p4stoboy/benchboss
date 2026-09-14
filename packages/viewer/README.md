# Spectator viewer

`renderSpectatorView(view)` validates and escapes the shared HTML blocks. It runs
without DOM APIs and remains the portable fallback for every game and replay.

## Optional canvas

Games may include `canvas: { renderer, version, state }` in `publicView(state)`.
`renderer` is a stable lowercase identifier; `version` is a positive integer naming
that renderer's public input contract. Change it for incompatible input semantics.
`state` is JSON public data, never internal game state or a seat observation.
Unknown/malformed canvas payloads do not invalidate the accompanying HTML blocks.

A game may export a `GameCanvasRenderer<State>` from a browser-only package subpath.
The host explicitly registers reviewed renderers and keeps the HTML view alongside
its canvas container:

```ts
import { mountCanvasView } from "@benchboss/viewer/canvas";
import { chessCanvas } from "@benchboss/game-chess/canvas";

const canvas = mountCanvasView(container, [chessCanvas], view);
canvas.update(nextView); // Same path for live updates and replay seeking.
canvas.destroy(); // On navigation/unmount.
```

An optional fourth mount argument `{ theme: () => palette }` supplies a `CanvasTheme`
from the host design tokens. It is read on each draw; call `update` after a theme
change. Theme and font choices never enter persisted game state.

The renderer supplies `id`, `version`, `aspectRatio`, `isState` and synchronous
`render(ctx, state, { width, height, theme })`. The mount validates bounded JSON and the
game-specific state, clones each snapshot, owns sizing and pixel density, and
redraws on updates/window resize. Each render must draw a complete snapshot without
network requests, timers, input mutation or dependence on earlier frames. Renderer
code is trusted bundled code; this interface is not a sandbox.

Missing 2D context, unsupported renderer/version, invalid data or drawing failures
hide only the canvas. Accessible HTML stays mounted. The root viewer export does
not import the browser entrypoint or any game renderer. Renderer versions remain
independent of the match execution identity; old frames without canvas still work.

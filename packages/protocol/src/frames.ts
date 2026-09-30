import type { PublicFrame, SpectatorBlock, SpectatorView } from "./index";

/**
 * The complete spectator view after the first `count` recorded frames of one stream, or
 * `null` for none. A frame's blocks replace the folded blocks with the same title and append
 * otherwise; progress, result, clocks and resources come from the last frame folded. The
 * result shares block objects with the frames; treat it as read-only.
 */
export function foldFrames(
  frames: readonly PublicFrame[],
  count = frames.length,
): SpectatorView | null {
  let folded: SpectatorView | null = null;
  for (const frame of frames.slice(0, count)) {
    const { blocks: changed, ...rest } = frame.view;
    if (!folded) {
      folded = { ...rest, blocks: [...changed] };
      continue;
    }
    const blocks: SpectatorBlock[] = [...folded.blocks];
    for (const block of changed) {
      const at = blocks.findIndex((b) => b.title === block.title);
      if (at === -1) blocks.push(block);
      else blocks[at] = block;
    }
    folded = { ...rest, blocks };
  }
  return folded;
}

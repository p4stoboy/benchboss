import { runMatchWorker } from "../../src/process-worker";
import { lifecycleGame } from "./lifecycle-game";

// Hold the write callback to exercise ordering independently of pipe speed.
const write = process.stdout.write.bind(process.stdout);
let pending = 0;
let writes = 0;
process.stdout.write = ((chunk: string, callback?: (error?: Error | null) => void) => {
  pending++;
  writes++;
  return write(chunk, (error) => {
    setTimeout(() => {
      pending--;
      callback?.(error);
    }, 5);
  });
}) as typeof process.stdout.write;
const collect = Bun.gc;
Bun.gc = (force) => {
  process.stderr.write(`${JSON.stringify({ force, pending, writes })}\n`);
  return collect(force);
};
await runMatchWorker(lifecycleGame().registry, {
  afterReply: process.argv.includes("--collect") ? () => Bun.gc(true) : undefined,
});

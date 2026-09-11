import { runMatchWorker } from "../../src/process-worker";
import { clockGame } from "./clock-game";

const fixture = clockGame();
const makeGame = fixture.plugin.makeGame;
fixture.plugin.makeGame = () => {
  const game = makeGame();
  let fault: unknown;
  return {
    ...game,
    newMatch(config, seed) {
      fault = config.rules.fault;
      return game.newMatch(config, seed);
    },
    submit(state, seat, input, tool) {
      if (fault === "exit") process.exit(7);
      if (fault === "hang")
        while (true) {
          /* fault injection */
        }
      if (fault === "output") process.stdout.write("x".repeat(100000));
      if (fault === "memory") {
        const memory = new Uint8Array(384 * 1024 * 1024);
        memory.fill(1);
        while (memory[0]) {
          /* keep resident until the parent kills this process */
        }
      }
      if (fault === "secret") {
        if (process.env.BENCHBOSS_TEST_SECRET) throw Error("inherited secret");
      }
      return game.submit(state, seat, input, tool);
    },
  };
};
await runMatchWorker(fixture.registry);

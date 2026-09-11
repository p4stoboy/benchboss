import { GAMES } from "@benchboss/games";
import { createRegistry, startLocalServer } from "@benchboss/host";

// An in-memory reference host. Operators supply their own persistence and policy.
export const startExampleServer = (port = 3000) =>
  startLocalServer({ registry: createRegistry(GAMES), port });

if (import.meta.main) {
  const local = startExampleServer();
  console.log(`BenchBoss reference host: ${local.server.url}`);
  const stop = () => {
    local.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

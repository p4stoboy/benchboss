import { runMatchWorker } from "../../src/process-worker";
import { lifecycleGame } from "./lifecycle-game";
await runMatchWorker(lifecycleGame().registry);

import { expect, test } from "bun:test";
import { createProcessTransport } from "../src/process-transport";

test.each([
  ["while(true) {}", "worker_timeout", { timeoutMs: 200 }],
  [
    'process.stdout.write("x".repeat(100000)); await Bun.sleep(5000)',
    "worker_output_limit",
    { maxMessageBytes: 1024 },
  ],
  [
    "const bytes = new Uint8Array(384*1024*1024); bytes.fill(1); while(bytes[0]) {}",
    "worker_memory_limit",
    { maxResidentBytes: 128 * 1024 * 1024 },
  ],
] as const)("process guard rejects %s with its specific fault", async (source, reason, limits) => {
  const transport = createProcessTransport({
    command: [process.execPath, "-e", source],
    timeoutMs: 4000,
    ...limits,
  });
  try {
    await expect(transport.request({})).rejects.toMatchObject({ reason });
  } finally {
    await transport.close();
  }
});

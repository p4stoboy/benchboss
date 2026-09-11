import { sourceFiles } from "./boundaries";
const configs = sourceFiles(".").filter((path) => path.endsWith("/tsconfig.json"));
for (const config of configs) {
  const result = Bun.spawnSync(
    [process.execPath, "x", "--no-install", "tsc", "--noEmit", "-p", config],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

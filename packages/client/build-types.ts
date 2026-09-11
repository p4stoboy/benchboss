import { build } from "rolldown";
import { dts } from "rolldown-plugin-dts";

await build({
  input: { index: "src/index.ts", metadata: "src/metadata.ts" },
  plugins: [
    dts({ generator: "tsgo", emitDtsOnly: true, tsconfig: "../../tsconfig.client-build.json" }),
  ],
  external: (id) =>
    id === "zod" || id.startsWith("@modelcontextprotocol/") || id.startsWith("node:"),
  output: { dir: "dist", format: "es" },
});

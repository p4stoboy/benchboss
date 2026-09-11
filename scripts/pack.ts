import { resolve } from "node:path";
import { packPackages } from "./packages";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1])
  throw Error("usage: bun scripts/pack.ts --output <new candidate directory>");
const output = resolve(args[1]);
const candidate = packPackages(resolve(import.meta.dir, ".."), output);
console.log(`Packed ${candidate.packages.length} packages into ${output}`);

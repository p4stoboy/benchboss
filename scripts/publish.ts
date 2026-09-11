import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readCandidate, selectPackages } from "./packages";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main")
  throw Error("Publication requires an explicit GitHub Actions release on main");
const [directory, selection] = process.argv.slice(2);
if (!directory || !selection || process.argv.length !== 4)
  throw Error("usage: bun scripts/publish.ts <candidate directory> <package names or all>");
const candidate = readCandidate(resolve(directory));
const selected = selectPackages(candidate, selection);
const getVersion = async (name: string, version: string) => {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`Registry lookup failed: ${name}@${version}: ${response.status}`);
  return (await response.json()) as { dist?: { integrity?: string } };
};
// Finish all conflict/dependency preflight checks before the first publication.
const published: string[] = [];
for (const pkg of selected) {
  const current = await getVersion(pkg.name, pkg.version);
  if (current) {
    if (current.dist?.integrity !== pkg.integrity)
      throw Error(`${pkg.name}@${pkg.version} already has different bytes`);
    published.push(pkg.name);
  }
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (!name.startsWith("@benchboss/")) continue;
    if (selected.some((p) => p.name === name && p.version === version)) continue;
    if (!(await getVersion(name, version)))
      throw Error(`Publish dependency ${name}@${version} first`);
  }
}
for (const pkg of selected) {
  if (published.includes(pkg.name)) {
    console.log(`Already published and identical: ${pkg.name}@${pkg.version}`);
    continue;
  }
  execFileSync(
    "npm",
    ["publish", join(resolve(directory), pkg.file), "--access", "public", "--ignore-scripts"],
    { stdio: "inherit", timeout: 120000 },
  );
}

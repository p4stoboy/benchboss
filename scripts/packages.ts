import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  files?: string[];
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}
export interface Package {
  dir: string;
  manifest: Manifest;
}
export interface Artifact {
  name: string;
  version: string;
  file: string;
  sha256: string;
  integrity: string;
  dependencies: Record<string, string>;
}
export interface Candidate {
  schemaVersion: 1;
  packages: Artifact[];
}
export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
export const writeJson = (file: string, value: unknown): void =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const run = (cwd: string, args: string[]): string => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0)
    throw Error(`${args.join(" ")} failed: ${result.error?.message ?? ""}\n${output}`);
  return output;
};
export function workspacePackages(root: string): Package[] {
  const paths: string[] = [];
  for (const pattern of readJson<Manifest>(join(root, "package.json")).workspaces ?? [])
    for (const path of globSync(`${pattern}/package.json`, { cwd: root }))
      if (!paths.includes(path)) paths.push(path);
  return [...paths]
    .sort()
    .map((path) => ({ dir: dirname(path), manifest: readJson<Manifest>(join(root, path)) }));
}
export function publishManifest(pkg: Manifest, owned: Package[]): Manifest {
  if (pkg.private || pkg.license !== "MIT" || !pkg.files?.length)
    throw Error(`${pkg.name}: package is not publishable`);
  const { devDependencies: _dev, scripts: _scripts, ...manifest } = pkg;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (!manifest[field]) continue;
    manifest[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, version]) => {
        if (!version.startsWith("workspace:")) return [name, version];
        const target = owned.find((p) => p.manifest.name === name);
        if (!target || target.manifest.private)
          throw Error(`${pkg.name}: cannot publish dependency ${name}`);
        return [name, target.manifest.version];
      }),
    );
  }
  return manifest;
}
export function assertTarContents(paths: string[]): void {
  for (const name of paths) {
    const parts = name.replace(/\/$/, "").split("/");
    if (
      parts[0] !== "package" ||
      parts.some(
        (part) =>
          part === ".." ||
          part.startsWith(".env") ||
          [".git", ".local", "node_modules", "tests", "__tests__"].includes(part),
      )
    )
      throw Error(`Forbidden package file: ${name}`);
    if (/\.(?:key|pem|p12|pfx)$/.test(name)) throw Error(`Forbidden package file: ${name}`);
  }
}
export function packPackages(root: string, destination: string): Candidate {
  if (existsSync(join(destination, "manifest.json")))
    throw Error("Candidate already exists; choose a new output directory");
  mkdirSync(destination, { recursive: true });
  const owned = workspacePackages(root);
  const packages: Artifact[] = [];
  for (const pkg of owned.filter((p) => !p.manifest.private)) {
    const stage = mkdtempSync(join(tmpdir(), "bb-pack-"));
    try {
      const manifest = publishManifest(pkg.manifest, owned);
      for (const path of manifest.files ?? []) {
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw Error("Invalid package allowlist");
        const source = join(root, pkg.dir, path);
        if (existsSync(source))
          cpSync(source, join(stage, path), { recursive: true, dereference: true });
      }
      if (!existsSync(join(stage, "LICENSE"))) throw Error(`${manifest.name}: missing license`);
      writeJson(join(stage, "package.json"), manifest);
      const file = `${manifest.name.replace("@", "").replaceAll("/", "-")}-${manifest.version}.tgz`;
      const target = join(destination, file);
      run(stage, ["pm", "pack", "--ignore-scripts", "--filename", target, "--quiet"]);
      assertTarContents(
        execFileSync("tar", ["-tzf", target], { encoding: "utf8" }).trim().split("\n"),
      );
      const bytes = readFileSync(target);
      packages.push({
        name: manifest.name,
        version: manifest.version,
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        dependencies: { ...manifest.dependencies, ...manifest.optionalDependencies },
      });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  const candidate: Candidate = { schemaVersion: 1, packages };
  writeJson(join(destination, "manifest.json"), candidate);
  return candidate;
}
export function readCandidate(directory: string): Candidate {
  const value = readJson<Candidate>(join(directory, "manifest.json"));
  if (value.schemaVersion !== 1 || !Array.isArray(value.packages) || !value.packages.length)
    throw Error("Unsupported candidate manifest");
  const names: string[] = [];
  for (const pkg of value.packages) {
    if (
      !/^@benchboss\/[a-z0-9-]+$/.test(pkg.name) ||
      !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
      names.includes(pkg.name) ||
      basename(pkg.file) !== pkg.file ||
      !pkg.file.endsWith(".tgz")
    )
      throw Error("Invalid candidate package");
    names.push(pkg.name);
    const bytes = readFileSync(join(directory, pkg.file));
    if (
      createHash("sha256").update(bytes).digest("hex") !== pkg.sha256 ||
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pkg.integrity
    )
      throw Error(`Candidate checksum mismatch: ${pkg.name}`);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", join(directory, pkg.file), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as Manifest;
    if (
      manifest.name !== pkg.name ||
      manifest.version !== pkg.version ||
      JSON.stringify({ ...manifest.dependencies, ...manifest.optionalDependencies }) !==
        JSON.stringify(pkg.dependencies)
    )
      throw Error(`Candidate manifest mismatch: ${pkg.name}`);
  }
  return value;
}
export function selectPackages(candidate: Candidate, selection: string): Artifact[] {
  const names =
    selection === "all"
      ? candidate.packages.map((p) => p.name)
      : selection.split(",").map((s) => s.trim());
  if (
    !names.length ||
    names.some((name, index) => names.indexOf(name) !== index) ||
    names.some((name) => !candidate.packages.some((p) => p.name === name))
  )
    throw Error("Select unique publishable package names or all");
  const remaining = candidate.packages.filter((p) => names.includes(p.name));
  const sorted: Artifact[] = [];
  while (remaining.length) {
    const index = remaining.findIndex((p) =>
      Object.keys(p.dependencies).every((dep) => !remaining.some((other) => other.name === dep)),
    );
    if (index === -1) throw Error("Cyclic package dependencies");
    const pkg = remaining.splice(index, 1)[0];
    if (pkg) sorted.push(pkg);
  }
  return sorted;
}
export const artifactOverrides = (
  candidate: Candidate,
  directory: string,
): Record<string, string> =>
  Object.fromEntries(
    candidate.packages.map((pkg) => [pkg.name, `file:${resolve(directory, pkg.file)}`]),
  );

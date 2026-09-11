import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Node, parseSync, visitorKeys } from "oxc-parser";

export const OWNERSHIP_ROOTS = ["packages", "games", "examples"] as const;
const PUBLIC_PACKAGES = [
  "@benchboss/core",
  "@benchboss/protocol",
  "@benchboss/schemas",
  "@benchboss/referee",
  "@benchboss/host",
  "@benchboss/viewer",
  "@benchboss/mcp",
  "@benchboss/games",
  "@benchboss/game-rps-n",
  "@benchboss/game-spy",
];
const IS_PUBLIC = true;

export function dependencyViolation(
  from: string,
  target: string,
  isRelative = false,
): string | null {
  if (target === ".." || target.startsWith("../") || isAbsolute(target))
    return "imports must stay inside this repository";
  if (IS_PUBLIC && from.startsWith("packages/") && target.startsWith("games"))
    return "runtime packages cannot depend on games";
  if (isRelative && IS_PUBLIC && from.split("/")[0] !== target.split("/")[0])
    return "cross-root imports must use package exports";
  return null;
}

export function moduleSpecifiers(source: string, filename = "input.ts"): string[] {
  const { program, errors } = parseSync(filename, source);
  if (errors.length) throw Error(`${filename}: ${errors.map((error) => error.message).join("; ")}`);
  const specs: string[] = [];
  const record = (node: Node | null | undefined): void => {
    if (node?.type === "Literal" && typeof node.value === "string") specs.push(node.value);
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
      const text = node.quasis[0]?.value.cooked;
      if (text != null) specs.push(text);
    }
  };
  const visit = (node: Node | null): void => {
    if (!node) return;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
      case "TSImportType":
        record(node.source);
        break;
      case "TSExternalModuleReference":
        record(node.expression);
        break;
      case "CallExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          record(node.arguments[0]);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, Node | (Node | null)[] | null>)[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child) visit(child);
    }
  };
  visit(program);
  return specs;
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      ["node_modules", "dist", ".git", ".local", ".netlify", "Claude outputs"].includes(
        entry.name,
      ) ||
      entry.isSymbolicLink()
    )
      return [];
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

export function checkBoundaries(root: string): string[] {
  const files = OWNERSHIP_ROOTS.flatMap((dir) => sourceFiles(resolve(root, dir)));
  const manifests = files.filter((path) => path.endsWith("/package.json"));
  const packages: Record<string, string> = {};
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    packages[manifest.name] = relative(root, dirname(file));
  }
  const violations: string[] = [];
  const inspect = (from: string, spec: string): void => {
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    const local = spec.startsWith(".") || isAbsolute(spec);
    const target = local
      ? relative(root, resolve(root, dirname(from), spec))
      : packages[name ?? ""];
    if (target != null) {
      const reason = dependencyViolation(from, target, local);
      if (reason) violations.push(`${from}: ${spec}: ${reason}`);
    } else if (
      spec.startsWith("@benchboss/") &&
      (IS_PUBLIC || !PUBLIC_PACKAGES.includes(name ?? ""))
    ) {
      violations.push(`${from}: unknown or private package ${spec}`);
    }
  };
  for (const file of files.filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))) {
    for (const spec of moduleSpecifiers(readFileSync(file, "utf8"), file))
      inspect(relative(root, file), spec);
  }
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        inspect(relative(root, file), name);
        if (
          name.startsWith("@benchboss/") &&
          !packages[name] &&
          !/^\d+\.\d+\.\d+$/.test(String(version))
        )
          violations.push(`${relative(root, file)}: ${name} must pin an exact registry version`);
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = checkBoundaries(resolve(import.meta.dir, ".."));
  for (const violation of violations) console.error(violation);
  if (violations.length) process.exit(1);
  console.log("Repository dependency boundaries passed.");
}

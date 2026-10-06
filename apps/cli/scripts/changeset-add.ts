#!/usr/bin/env bun
/**
 * Non-interactive changeset creator for AI agents
 *
 * Usage:
 *   bun run changeset-add.ts <type> <summary>
 *   bun run changeset-add.ts <package> <type> <summary>
 *   bun run changeset-add.ts both <type> <summary>
 *
 * Packages: cli (default), web, both
 *
 * Examples:
 *   bun run changeset-add.ts patch "Fix daemon exit code"
 *   bun run changeset-add.ts web minor "Add install guide page"
 *   bun run changeset-add.ts both patch "Update shared CI tooling"
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Minimal package manifest fields needed by the non-interactive changeset tool. */
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

type ChangesetType = "patch" | "minor" | "major";
type PackageTarget = "cli" | "web";
type PackageTargetArg = PackageTarget | "both";

interface ResolvedTargets {
  summary: string;
  targets: PackageTarget[];
  type: ChangesetType;
}

const changesetTypes = ["patch", "minor", "major"] as const;
const packageTargets = ["cli", "web", "both"] as const;

const packageManifestPaths: Record<PackageTarget, string> = {
  cli: "apps/cli/package.json",
  web: "apps/web/package.json",
};

const CHANGESET_DIRECTORY = ".changeset";

const isChangesetType = (type: string | undefined): type is ChangesetType =>
  changesetTypes.some((candidate) => candidate === type);

const isPackageTarget = (
  value: string | undefined
): value is PackageTargetArg =>
  packageTargets.some((candidate) => candidate === value);

const findMonorepoRoot = (startDir: string) => {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, CHANGESET_DIRECTORY))) {
      return currentDir;
    }

    currentDir = path.dirname(currentDir);
  }

  if (existsSync(path.join(currentDir, CHANGESET_DIRECTORY))) {
    return currentDir;
  }

  console.error(
    "Could not find monorepo root (.changeset) from script location"
  );
  process.exit(1);
};

const readPackageJson = (packageJsonPath: string) => {
  try {
    const packageJson: PackageJson = JSON.parse(
      readFileSync(packageJsonPath, "utf-8")
    );
    return packageJson;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to read package.json: ${message}`);
    process.exit(1);
  }
};

const getPackageName = (packageJson: PackageJson) => {
  if (!packageJson.name?.trim()) {
    console.error("package.json must include a non-empty name field");
    process.exit(1);
  }

  return packageJson.name;
};

const hasChangesetsCliDependency = (packageJson: PackageJson) =>
  Boolean(
    packageJson.dependencies?.["@changesets/cli"] ||
    packageJson.devDependencies?.["@changesets/cli"] ||
    packageJson.optionalDependencies?.["@changesets/cli"] ||
    packageJson.peerDependencies?.["@changesets/cli"]
  );

const assertChangesetsCliInstalled = (
  packageJson: PackageJson,
  projectRoot: string
) => {
  if (!hasChangesetsCliDependency(packageJson)) {
    console.error('Missing dependency: "@changesets/cli"');
    console.error('Install it with: bun add -d "@changesets/cli"');
    process.exit(1);
  }

  const requireFromProject = createRequire(
    path.join(projectRoot, "package.json")
  );

  try {
    requireFromProject.resolve("@changesets/cli/package.json");
  } catch {
    console.error('Dependency "@changesets/cli" is declared but not installed');
    console.error("Run: bun install");
    process.exit(1);
  }
};

const parseChangesetType = (type: string | undefined): ChangesetType => {
  if (isChangesetType(type)) {
    return type;
  }

  console.error(`Invalid type: ${type}. Must be patch, minor, or major.`);
  process.exit(1);
};

const createChangesetFilename = (changesetDir: string) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomBytes(4).toString("hex");
    const filename = path.join(changesetDir, `${id}.md`);

    if (!existsSync(filename)) {
      return filename;
    }
  }

  console.error("Could not generate a unique changeset filename");
  process.exit(1);
};

const resolveTargets = (args: string[]): ResolvedTargets => {
  if (args.length < 2) {
    console.error("Usage: changeset-add.ts [cli|web|both] <type> <summary>");
    console.error("  package: cli (default) | web | both");
    console.error("  type: patch | minor | major");
    process.exit(1);
  }

  if (isPackageTarget(args[0])) {
    const [target, type, ...summaryParts] = args;
    const summary = summaryParts.join(" ");

    if (!summary.trim()) {
      console.error("Summary cannot be empty");
      process.exit(1);
    }

    return {
      summary,
      targets: target === "both" ? ["cli", "web"] : [target],
      type: parseChangesetType(type),
    };
  }

  const [type, ...summaryParts] = args;
  const summary = summaryParts.join(" ");

  if (!summary.trim()) {
    console.error("Summary cannot be empty");
    process.exit(1);
  }

  return {
    summary,
    targets: ["cli"],
    type: parseChangesetType(type),
  };
};

const args = process.argv.slice(2);
const { targets, type: changesetType, summary } = resolveTargets(args);
const monorepoRoot = findMonorepoRoot(import.meta.dirname);
const rootPackageJson = readPackageJson(
  path.join(monorepoRoot, "package.json")
);
assertChangesetsCliInstalled(rootPackageJson, monorepoRoot);

const frontmatter = targets
  .map((target) => {
    const manifestPath = path.join(monorepoRoot, packageManifestPaths[target]);
    const packageName = getPackageName(readPackageJson(manifestPath));
    return `"${packageName}": ${changesetType}`;
  })
  .join("\n");

const changesetDir = path.join(monorepoRoot, ".changeset");
const filename = createChangesetFilename(changesetDir);
const relativeFilename = path.relative(monorepoRoot, filename);

const content = `---
${frontmatter}
---

${summary.trim()}
`;

mkdirSync(changesetDir, { recursive: true });
writeFileSync(filename, content);
console.log(`✓ Created changeset: ${relativeFilename}`);
for (const target of targets) {
  const packageName = getPackageName(
    readPackageJson(path.join(monorepoRoot, packageManifestPaths[target]))
  );
  console.log(`  Package: ${packageName}`);
}
console.log(`  Type: ${changesetType}`);
console.log(`  Summary: ${summary}`);

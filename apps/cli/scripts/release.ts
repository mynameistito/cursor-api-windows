#!/usr/bin/env bun
/**
 * Release tooling for CI and local use.
 *
 * Usage:
 *   bun run release ci
 *   bun run release tag [--github-output]
 *   bun run release zip [--tag v0.1.0]
 *   bun run release upload [--tag v0.1.0] [--glob dist/*.zip]
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  globSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import packageJson from "@package";
import { $ } from "bun";
import { Command } from "commander";

interface GitHubReleaseAsset {
  id: number;
  name: string;
}

interface GitHubRelease {
  assets: GitHubReleaseAsset[];
  id: number;
  upload_url: string;
}

const packageRoot = path.join(import.meta.dirname, "..");
const monorepoRoot = path.join(packageRoot, "..", "..");
const bundleDir = path.join(packageRoot, "dist", "cursor-api");
const distDir = path.join(packageRoot, "dist");

const resolveReleaseTag = (published?: boolean): string => {
  const githubRef = process.env.GITHUB_REF ?? "";
  const githubRefName = process.env.GITHUB_REF_NAME ?? "";
  const isPublished =
    published ??
    (process.env.PUBLISHED === "true" ||
      process.env.PUBLISHED === "1" ||
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch");

  if (githubRef.startsWith("refs/tags/v")) {
    return githubRefName;
  }

  if (isPublished) {
    return `v${packageJson.version}`;
  }

  return "";
};

const releaseVersionFromTag = (tag: string): string =>
  tag.replace(/^v/u, "") || "0.0.0-dev";

const writeReleaseTagOutput = (published?: boolean): string => {
  const tag = resolveReleaseTag(published);
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath) {
    appendFileSync(outputPath, `tag=${tag}\n`);
  }

  if (tag) {
    console.log(tag);
  }

  return tag;
};

const zipRelease = async (tag?: string): Promise<string> => {
  const version = releaseVersionFromTag(tag ?? resolveReleaseTag());
  const zipPath = path.join(distDir, `cursor-api-${version}-win-x64.zip`);
  const bundleGlob = path.join(bundleDir, "*");

  await $`powershell -NoProfile -Command Compress-Archive -Path ${bundleGlob} -DestinationPath ${zipPath} -Force`;

  console.log(`Zipped: ${zipPath}`);
  return zipPath;
};

const buildGitHubClient = (token: string, repository: string) => {
  const [owner, repo] = repository.split("/");
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cursor-api-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const request = async (
    input: string,
    init: RequestInit = {}
  ): Promise<Response> => {
    const response = await fetch(input, {
      ...init,
      headers: {
        ...headers,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `${init.method ?? "GET"} ${input} failed: ${response.status} ${body}`
      );
    }

    return response;
  };

  const getReleaseByTag = async (
    releaseTag: string
  ): Promise<GitHubRelease | null> => {
    const response = await fetch(
      `${apiBase}/releases/tags/${encodeURIComponent(releaseTag)}`,
      { headers }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GET release ${releaseTag} failed: ${response.status} ${body}`
      );
    }

    return (await response.json()) as GitHubRelease;
  };

  const createRelease = async (
    releaseTag: string,
    notes: string
  ): Promise<GitHubRelease> => {
    const response = await request(`${apiBase}/releases`, {
      body: JSON.stringify({
        body: notes,
        make_latest: "true",
        tag_name: releaseTag,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    return (await response.json()) as GitHubRelease;
  };

  const updateReleaseNotes = async (
    releaseId: number,
    notes: string
  ): Promise<void> => {
    await request(`${apiBase}/releases/${releaseId}`, {
      body: JSON.stringify({ body: notes }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    });
  };

  const deleteAsset = async (assetId: number): Promise<void> => {
    await request(`${apiBase}/releases/assets/${assetId}`, {
      method: "DELETE",
    });
  };

  const markLatest = async (releaseId: number): Promise<void> => {
    await request(`${apiBase}/releases/${releaseId}`, {
      body: JSON.stringify({ make_latest: "true" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    });
  };

  const uploadAsset = async (
    release: GitHubRelease,
    filePath: string
  ): Promise<void> => {
    const name = path.basename(filePath);
    const existing = release.assets.find((asset) => asset.name === name);

    if (existing) {
      await deleteAsset(existing.id);
    }

    const body = readFileSync(filePath);
    const uploadUrl = release.upload_url.replace(
      /\{.*\}$/u,
      `?name=${encodeURIComponent(name)}`
    );

    await request(uploadUrl, {
      body,
      headers: {
        "Content-Length": String(body.byteLength),
        "Content-Type": "application/zip",
      },
      method: "POST",
    });

    console.log(`Uploaded ${name}`);
  };

  return {
    createRelease,
    getReleaseByTag,
    markLatest,
    updateReleaseNotes,
    uploadAsset,
  };
};

const escapeRegex = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const normalizeNewlines = (value: string): string =>
  value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

const readChangelog = (): string | null => {
  const changelogPath = path.join(packageRoot, "CHANGELOG.md");

  if (!existsSync(changelogPath)) {
    return null;
  }

  return normalizeNewlines(readFileSync(changelogPath, "utf-8"));
};

const readReleaseNotes = (version: string): string => {
  const changelog = readChangelog();

  if (!changelog) {
    return `Release v${version}`;
  }

  const sectionRegex = new RegExp(
    `(?:^|\n)##\\s+${escapeRegex(version)}\\s*\n([\\s\\S]*?)(?=\n##\\s+|(?![\\s\\S]))`,
    "u"
  );
  const match = changelog.match(sectionRegex);

  return match?.[1]?.trim() || `Release v${version}`;
};

const uploadRelease = async (options: {
  fileGlob?: string;
  tag?: string;
}): Promise<void> => {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const releaseTag =
    options.tag ?? process.env.GITHUB_REF_NAME ?? process.env.RELEASE_TAG;
  const fileGlob = options.fileGlob ?? "dist/cursor-api-*-win-x64.zip";

  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  if (!repository?.includes("/")) {
    throw new Error("GITHUB_REPOSITORY must be set to owner/repo");
  }

  if (!releaseTag?.startsWith("v")) {
    throw new Error(
      "Release tag must start with v (pass --tag or set RELEASE_TAG / GITHUB_REF_NAME)"
    );
  }

  const files = globSync(fileGlob).map((file) => path.resolve(file));

  if (files.length === 0) {
    throw new Error(`No release files matched: ${fileGlob}`);
  }

  const github = buildGitHubClient(token, repository);
  let release = await github.getReleaseByTag(releaseTag);
  const notes = readReleaseNotes(releaseVersionFromTag(releaseTag));

  if (release) {
    await github.markLatest(release.id);
    await github.updateReleaseNotes(release.id, notes);
  } else {
    console.log(`Creating GitHub release for ${releaseTag}`);
    release = await github.createRelease(releaseTag, notes);
  }

  await Promise.all(files.map((file) => github.uploadAsset(release, file)));

  console.log(`Release ${releaseTag} assets uploaded.`);
};

const runCommand = (command: string, args: string[]): string =>
  execFileSync(command, args, {
    cwd: packageRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const runInherited = (
  command: string,
  args: string[],
  cwd: string = packageRoot
): void => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

const expectedReleaseAsset = (version: string): string =>
  `cursor-api-${version}-win-x64.zip`;

const fetchReleaseAssetNames = (tag: string): string[] => {
  const output = runCommand("gh", [
    "release",
    "view",
    tag,
    "--json",
    "assets",
    "--jq",
    ".assets[].name",
  ]);

  return output ? output.split("\n") : [];
};

const releaseHasExpectedAsset = (tag: string, version: string): boolean => {
  try {
    const names = fetchReleaseAssetNames(tag);
    return names.includes(expectedReleaseAsset(version));
  } catch {
    return false;
  }
};

const updateGitHubReleaseNotes = (tag: string, version: string): void => {
  const notesPath = path.join(monorepoRoot, ".changeset", "RELEASE_NOTES.md");

  writeFileSync(notesPath, readReleaseNotes(version));
  runInherited("gh", ["release", "edit", tag, "--notes-file", notesPath]);
};

const ciRelease = async (): Promise<void> => {
  const { version } = packageJson;
  const tag = `v${version}`;
  const assetName = expectedReleaseAsset(version);

  if (releaseHasExpectedAsset(tag, version)) {
    updateGitHubReleaseNotes(tag, version);
    console.log(`Release ${tag} already exists with ${assetName}.`);
    return;
  }

  runInherited("bun", ["run", "typecheck"], packageRoot);
  runInherited("bun", ["run", "build:cli"], monorepoRoot);

  const zipPath = await zipRelease(tag);

  if (!existsSync(zipPath)) {
    throw new Error(`Missing build artifact: ${zipPath}`);
  }

  const notesPath = path.join(monorepoRoot, ".changeset", "RELEASE_NOTES.md");
  writeFileSync(notesPath, readReleaseNotes(version));

  const target = runCommand("git", ["rev-parse", "HEAD"]);

  try {
    runInherited("gh", [
      "release",
      "create",
      tag,
      zipPath,
      "--title",
      tag,
      "--notes-file",
      notesPath,
      "--target",
      target,
    ]);
  } catch (error) {
    let present: string[];

    try {
      present = fetchReleaseAssetNames(tag);
    } catch {
      throw error;
    }

    if (!present.includes(assetName)) {
      console.error(`Release ${tag} is missing asset: ${assetName}`);
      process.exit(1);
    }

    console.log(`Release ${tag} already has ${assetName}.`);
  }
};

const program = new Command("release")
  .description("Release helpers for CI and local builds")
  .showHelpAfterError();

program
  .command("ci")
  .description(
    "Build and publish an immutable GitHub release (skips when the zip already exists)"
  )
  .action(async () => {
    await ciRelease();
  });

program
  .command("tag")
  .description("Resolve the GitHub release tag for the current CI context")
  .option("--github-output", "Write tag= to GITHUB_OUTPUT")
  .option(
    "--published",
    "Treat the run as a Changesets publish (also reads PUBLISHED=1)"
  )
  .action((options: { githubOutput?: boolean; published?: boolean }) => {
    if (options.githubOutput && !process.env.GITHUB_OUTPUT) {
      throw new Error("GITHUB_OUTPUT is not set");
    }

    writeReleaseTagOutput(options.published);
  });

program
  .command("zip")
  .description("Zip dist/cursor-api into a Windows release archive")
  .option("--tag <tag>", "Release tag used to name the zip")
  .action(async (options: { tag?: string }) => {
    await zipRelease(options.tag);
  });

program
  .command("upload")
  .description("Upload release zip assets to GitHub")
  .option(
    "--tag <tag>",
    "Release tag (default: RELEASE_TAG or GITHUB_REF_NAME)"
  )
  .option("--glob <pattern>", "Zip glob", "dist/cursor-api-*-win-x64.zip")
  .option("--if-tagged", "Skip upload when no release tag can be resolved")
  .action(
    async (options: { tag?: string; glob?: string; ifTagged?: boolean }) => {
      const releaseTag = options.tag ?? resolveReleaseTag();

      if (options.ifTagged && !releaseTag) {
        console.log("No release tag resolved; skipping upload.");
        return;
      }

      await uploadRelease({
        fileGlob: options.glob,
        tag: releaseTag,
      });
    }
  );

await program.parseAsync(process.argv);

#!/usr/bin/env bun
/**
 * Release tooling for CI and local use.
 *
 * Usage:
 *   bun run release tag [--github-output]
 *   bun run release zip [--tag v0.1.0]
 *   bun run release upload [--tag v0.1.0] [--glob dist/*.zip]
 */

import { appendFileSync, globSync, readFileSync } from "node:fs";
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

const projectRoot = path.join(import.meta.dirname, "..");
const bundleDir = path.join(projectRoot, "dist", "cursor-api");
const distDir = path.join(projectRoot, "dist");

const resolveReleaseTag = (published?: boolean): string => {
  const githubRef = process.env.GITHUB_REF ?? "";
  const githubRefName = process.env.GITHUB_REF_NAME ?? "";
  const isPublished =
    published ??
    (process.env.PUBLISHED === "true" || process.env.PUBLISHED === "1");

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

  const createRelease = async (releaseTag: string): Promise<GitHubRelease> => {
    const response = await request(`${apiBase}/releases`, {
      body: JSON.stringify({
        generate_release_notes: true,
        make_latest: true,
        tag_name: releaseTag,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    return (await response.json()) as GitHubRelease;
  };

  const deleteAsset = async (assetId: number): Promise<void> => {
    await request(`${apiBase}/releases/assets/${assetId}`, {
      method: "DELETE",
    });
  };

  const markLatest = async (releaseId: number): Promise<void> => {
    await request(`${apiBase}/releases/${releaseId}`, {
      body: JSON.stringify({ make_latest: true }),
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
    uploadAsset,
  };
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

  if (release) {
    await github.markLatest(release.id);
  } else {
    console.log(`Creating GitHub release for ${releaseTag}`);
    release = await github.createRelease(releaseTag);
  }

  await Promise.all(files.map((file) => github.uploadAsset(release, file)));

  console.log(`Release ${releaseTag} assets uploaded.`);
};

const program = new Command("release")
  .description("Release helpers for CI and local builds")
  .showHelpAfterError();

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

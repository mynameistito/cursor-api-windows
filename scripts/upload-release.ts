#!/usr/bin/env bun
/**
 * Upload release zip assets to an existing GitHub release via the REST API.
 *
 * Usage:
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_REF_NAME=v0.1.0 \
 *     bun run scripts/upload-release.ts [glob]
 *
 * Default glob: dist/cursor-api-*-win-x64.zip
 */

import { globSync, readFileSync } from "node:fs";
import path from "node:path";

interface GitHubReleaseAsset {
  id: number;
  name: string;
}

interface GitHubRelease {
  assets: GitHubReleaseAsset[];
  id: number;
  upload_url: string;
}

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const fileGlob = process.argv[3] ?? "dist/cursor-api-*-win-x64.zip";

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

if (!repository?.includes("/")) {
  console.error("GITHUB_REPOSITORY must be set to owner/repo");
  process.exit(1);
}

if (!tag?.startsWith("v")) {
  console.error(
    "Release tag must start with v (set GITHUB_REF_NAME or pass as argv[2])"
  );
  process.exit(1);
}

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

const getReleaseByTag = async (): Promise<GitHubRelease | null> => {
  const response = await fetch(
    `${apiBase}/releases/tags/${encodeURIComponent(tag)}`,
    { headers }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET release ${tag} failed: ${response.status} ${body}`);
  }

  return (await response.json()) as GitHubRelease;
};

const createRelease = async (): Promise<GitHubRelease> => {
  const response = await request(`${apiBase}/releases`, {
    body: JSON.stringify({
      generate_release_notes: true,
      make_latest: true,
      tag_name: tag,
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

const markLatest = async (releaseId: number): Promise<void> => {
  await request(`${apiBase}/releases/${releaseId}`, {
    body: JSON.stringify({ make_latest: true }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "PATCH",
  });
};

const files = globSync(fileGlob).map((file) => path.resolve(file));

if (files.length === 0) {
  console.error(`No release files matched: ${fileGlob}`);
  process.exit(1);
}

let release = await getReleaseByTag();

if (release) {
  await markLatest(release.id);
} else {
  console.log(`Creating GitHub release for ${tag}`);
  release = await createRelease();
}

await Promise.all(files.map((file) => uploadAsset(release, file)));

console.log(`Release ${tag} assets uploaded.`);

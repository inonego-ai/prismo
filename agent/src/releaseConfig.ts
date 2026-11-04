import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GitHubSource = { owner: string; repo: string };
export const DEFAULT_RELEASE_CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)), "../../release-config.json"
);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function loadGitHubSource(
  path = DEFAULT_RELEASE_CONFIG
): Promise<GitHubSource | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!raw || typeof raw !== "object" || !("github" in raw)) {
    throw new Error("Release configuration is invalid");
  }
  const github: unknown = raw.github;
  if (github === null) return null;
  if (!github || typeof github !== "object" || !("owner" in github)
    || !("repo" in github) || typeof github.owner !== "string"
    || typeof github.repo !== "string" || !SEGMENT.test(github.owner)
    || !SEGMENT.test(github.repo)
    || github.repo.endsWith(".git") || github.repo === "." || github.repo === "..") {
    throw new Error("GitHub release owner/repo is invalid");
  }
  return { owner: github.owner, repo: github.repo };
}

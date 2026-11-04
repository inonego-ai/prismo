import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execGit } from "./git.js";

export interface Repository { id: string; name: string; path: string }

export function configPath(): string {
  const root = process.env.PRISMO_CONFIG_DIR ?? process.env.LOCALAPPDATA ?? join(homedir(), ".config");
  return join(root, "Prismo", "repositories.json");
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
const normalized = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

const { lock } = createRequire(import.meta.url)("proper-lockfile") as {
  lock: (path: string, options: {
    realpath: boolean; lockfilePath: string; stale: number; update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
  }) => Promise<() => Promise<void>>;
};

async function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  const release = await lock(target, {
    realpath: false, lockfilePath: target + ".lockdir", stale: 30_000, update: 5_000,
    retries: { retries: 200, factor: 1, minTimeout: 50, maxTimeout: 50 }
  });
  try { return await operation(); }
  finally { await release(); }
}

export async function listRepositories(): Promise<Repository[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || !("repositories" in parsed)
      || !Array.isArray(parsed.repositories)) throw Error("Invalid Prismo configuration");
    const items = parsed.repositories as unknown[];
    if (!items.every(item => typeof item === "object" && item !== null
      && "id" in item && typeof item.id === "string"
      && "name" in item && typeof item.name === "string"
      && "path" in item && typeof item.path === "string")) {
      throw Error("Invalid repository entry");
    }
    return items as Repository[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function saveRepositories(repositories: Repository[]): Promise<void> {
  await writeJsonAtomically(configPath(), { repositories });
}
export async function repositoryRoot(location: string): Promise<string> {
  const path = await realpath(resolve(location));
  let repositoryPath: string | null = null;
  for (let current = path;;) {
    try {
      const marker = await lstat(join(current, ".git"));
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
        throw Error("Invalid Git metadata");
      }
      repositoryPath = current;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!repositoryPath) throw Error("Not a Git working tree");
  const root = (await execGit(path, ["rev-parse", "--show-toplevel"], repositoryPath)).trim();
  if (!root || normalized(await realpath(root)) !== normalized(repositoryPath)) {
    throw Error("Not a Git working tree");
  }
  return await realpath(repositoryPath);
}
export async function addRepository(location: string): Promise<Repository> {
  const path = await repositoryRoot(location);
  return withConfigLock(async () => {
    const existing = await listRepositories();
    const found = existing.find(repo => normalized(repo.path) === normalized(path));
    if (found) return found;
    const repo = { id: randomUUID(), name: basename(path), path };
    await saveRepositories([...existing, repo]);
    return repo;
  });
}
export async function removeRepository(id: string): Promise<boolean> {
  return withConfigLock(async () => {
    const repositories = await listRepositories();
    if (!repositories.some(repo => repo.id === id)) return false;
    await saveRepositories(repositories.filter(repo => repo.id !== id));
    return true;
  });
}
export async function requireRepository(id: string): Promise<Repository | undefined> {
  return (await listRepositories()).find(repo => repo.id === id);
}

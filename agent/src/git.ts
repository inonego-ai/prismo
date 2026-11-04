import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Repository } from "./config.js";

const exec = promisify(execFile);
const MAX_GIT = 2 * 1024 * 1024;
const MAX_FILE = 512 * 1024;
const MAX_ACTIVE_GIT = 4;
const MAX_PENDING_GIT = 32;
let activeGit = 0;
const waitingGit: Array<() => void> = [];
async function withGitSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeGit >= MAX_ACTIVE_GIT) {
    if (waitingGit.length >= MAX_PENDING_GIT) {
      throw new AccessError("Git service is busy", 429);
    }
    await new Promise<void>(resolve => waitingGit.push(resolve));
  } else {
    activeGit++;
  }
  try {
    return await operation();
  } finally {
    const next = waitingGit.shift();
    if (next) next();
    else activeGit--;
  }
}
const protectedPart = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
const protectedExtension = /\.(?:pem|p12|pfx|key|keystore|tfstate|tfvars)$/i;
export class AccessError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export function isProtectedPath(path: string): boolean {
  return path.split(/[\\/]/).some(part => {
    const name = part.replace(/[. ]+$/, "");
    return protectedPart.test(name) || protectedExtension.test(name);
  });
}
export function validatePath(path: string): string {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes(":") || path.includes("\\") || isAbsolute(path)
    || /^[A-Za-z]:/.test(path)) throw new AccessError("Invalid path");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".."
    || /[. ]$/.test(part)) || isProtectedPath(path)) {
    throw new AccessError("Path is not accessible", 403);
  }
  return path;
}
export async function safePath(root: string, requested = ""): Promise<string> {
  const rootStat = await lstat(root);
  const actualRoot = await realpath(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || relative(root, actualRoot) !== "") {
    throw new AccessError("Repository root changed", 403);
  }
  if (!requested) return actualRoot;
  const path = validatePath(requested);
  const target = resolve(root, ...path.split("/"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) {
    throw new AccessError("Path escapes repository", 403);
  }
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new AccessError("Symbolic links are not accessible", 403);
  }
  const actual = await realpath(target);
  const actualRelative = relative(root, actual);
  if (actualRelative === ".." || actualRelative.startsWith(".." + sep)
    || isAbsolute(actualRelative)) throw new AccessError("Path escapes repository", 403);
  if (isProtectedPath(actualRelative)) throw new AccessError("Path is not accessible", 403);
  return actual;
}
export async function execGit(cwd: string, args: string[], workTreeRoot?: string): Promise<string> {
  const result = await withGitSlot(async () => {
    const root = await safePath(cwd);
    let workTree: string | undefined;
    if (workTreeRoot !== undefined) {
      workTree = await safePath(workTreeRoot);
      let gitMetadata;
      try { gitMetadata = await lstat(join(workTree, ".git")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AccessError("Not a Git repository", 404);
        }
        throw error;
      }
      if (gitMetadata.isSymbolicLink()
        || (!gitMetadata.isDirectory() && !gitMetadata.isFile())) {
        throw new AccessError("Invalid Git metadata", 403);
      }
    }
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME",
      "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return exec("git", [
      ...(workTree ? ["-c", "core.bare=false", "--work-tree=" + workTree] : []),
      "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.fsmonitor=false",
      "--no-pager", ...args
    ], {
      cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: MAX_GIT, windowsHide: true,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "",
        GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" }
    });
  });
  return result.stdout;
}
function execRepoGit(repo: Repository, args: string[]): Promise<string> {
  return execGit(repo.path, args, repo.path);
}
export interface Change {
  path: string; previousPath?: string; staged: boolean; unstaged: boolean;
  untracked: boolean; kind: string;
}
export interface RepoStatus { branch: string; head: string | null; changes: Change[] }
export function parseStatus(output: string): RepoStatus {
  let branch = "(unknown)"; let head: string | null = null;
  const changes: Change[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (!record) continue;
    if (record.startsWith("# branch.head ")) { branch = record.slice(14).trim(); continue; }
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice(13).trim();
      head = oid === "(initial)" ? null : oid;
      continue;
    }
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (!isProtectedPath(path)) changes.push({ path, staged: false, unstaged: false, untracked: true, kind: "added" });
      continue;
    }
    if (record.startsWith("u ")) {
      const path = record.split(" ").slice(10).join(" ");
      if (path && !isProtectedPath(path)) {
        changes.push({
          path, staged: false, unstaged: false, untracked: false, kind: "conflicted"
        });
      }
      continue;
    }
    if (!record.startsWith("1 ") && !record.startsWith("2 ")) continue;
    const fields = record.split(" ");
    const marker = fields[0];
    const xy = fields[1] ?? "..";
    const path = record.split(" ").slice(marker === "2" ? 9 : 8).join(" ");
    let previousPath: string | undefined;
    if (marker === "2") previousPath = records[++i];
    if (!path || isProtectedPath(path) || (previousPath && isProtectedPath(previousPath))) continue;
    const flag = xy.replaceAll(".", "");
    const kind = marker === "2" && (xy[0] === "R" || xy[1] === "R") ? "renamed"
      : flag.includes("D") ? "deleted" : flag.includes("A") ? "added" : "modified";
    changes.push({
      path, ...(previousPath ? { previousPath } : {}),
      staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, kind
    });
  }
  return { branch, head, changes };
}
export async function getStatus(repo: Repository): Promise<RepoStatus> {
  return parseStatus(await execRepoGit(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]));
}
type RepoIssue = "unavailable" | "temporary";
export async function getRepositorySummaries(repositories: Repository[]) {
  const summaries: Array<{ repo: Repository; status: RepoStatus | null; issue: RepoIssue | null }> = [];
  for (let index = 0; index < repositories.length; index += MAX_ACTIVE_GIT) {
    const batch = await Promise.all(repositories.slice(index, index + MAX_ACTIVE_GIT)
      .map(async repo => {
        try {
          return { repo, status: await getStatus(repo), issue: null };
        } catch (error) {
          const code = (error as { code?: string | number }).code;
          let unavailable = (error as { statusCode?: number }).statusCode === 404
            || code === 128 && /not a git repository/i.test(
            String((error as { stderr?: unknown }).stderr ?? ""));
          if (!unavailable && typeof code === "string" &&
            ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code)) {
            try { unavailable = !(await stat(repo.path)).isDirectory(); }
            catch { unavailable = true; }
          }
          const issue: RepoIssue = unavailable ? "unavailable" : "temporary";
          return { repo, status: null, issue };
        }
      }));
    summaries.push(...batch);
  }
  return summaries;
}
export async function readRepoFile(repo: Repository, path: string): Promise<string> {
  const full = await safePath(repo.path, path);
  const expected = await lstat(full);
  if (!expected.isFile()) throw new AccessError("Not a regular file", 400);
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(full);
    if (!opened.isFile() || !current.isFile()
      || opened.dev !== expected.dev || opened.ino !== expected.ino
      || current.dev !== opened.dev || current.ino !== opened.ino
      || await realpath(full) !== full) {
      throw new AccessError("File changed while opening", 403);
    }
    if (opened.size > MAX_FILE) throw new AccessError("File too large", 413);
    const buffer = Buffer.allocUnsafe(MAX_FILE + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE) throw new AccessError("File too large", 413);
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new AccessError("Binary file cannot be rendered", 415);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
type TreeEntry = { name: string; path: string; directory: boolean };
type TreeSnapshot = { repoID: string; path: string; expiresAt: number; entries: TreeEntry[] };
const TREE_PAGE_SIZE = 200;
const TREE_SNAPSHOT_MS = 5 * 60_000;
const MAX_TREE_SNAPSHOTS = 12;
const MAX_TREE_ENTRIES = 50_000;

/** A cursor references one immutable directory listing for the duration of browsing. */
export class TreeStore {
  private readonly snapshots = new Map<string, TreeSnapshot>();

  async list(repo: Repository, path = "", cursor?: string) {
    let snapshot: TreeSnapshot;
    let key: string;
    let offset = 0;
    const now = Date.now();
    for (const [id, item] of this.snapshots) {
      if (item.expiresAt <= now) this.snapshots.delete(id);
    }
    if (cursor !== undefined) {
      const match = /^([a-f0-9]{32}):(\d+)$/.exec(cursor);
      if (!match) throw new AccessError("Invalid tree cursor");
      key = match[1]!;
      offset = Number(match[2]);
      const existing = this.snapshots.get(key);
      if (!existing || existing.repoID !== repo.id || existing.path !== path
        || !Number.isSafeInteger(offset) || offset < 1 || offset >= existing.entries.length) {
        throw new AccessError("Tree listing expired", 410);
      }
      snapshot = existing;
    } else {
      const root = await safePath(repo.path, path);
      const source = await readdir(root, { withFileTypes: true });
      if (source.length > MAX_TREE_ENTRIES) throw new AccessError("Directory too large", 413);
      const entries = source.filter(item => !item.isSymbolicLink() && !isProtectedPath(item.name))
        .map(item => ({
          name: item.name, path: path ? path + "/" + item.name : item.name,
          directory: item.isDirectory()
        }))
        .sort((a, b) => Number(b.directory) - Number(a.directory)
          || a.name.localeCompare(b.name));
      key = randomBytes(16).toString("hex");
      snapshot = { repoID: repo.id, path, expiresAt: now + TREE_SNAPSHOT_MS, entries };
      if (entries.length > TREE_PAGE_SIZE) {
        while (this.snapshots.size >= MAX_TREE_SNAPSHOTS) {
          this.snapshots.delete(this.snapshots.keys().next().value!);
        }
        this.snapshots.set(key, snapshot);
      }
    }
    const entries = snapshot.entries.slice(offset, offset + TREE_PAGE_SIZE);
    const nextOffset = offset + entries.length;
    return {
      entries,
      nextCursor: nextOffset < snapshot.entries.length ? key + ":" + nextOffset : null
    };
  }
}
/** Validate every Git raw change against the requested paths before exposing the patch. */
function verifiedDiff(output: string, allowedPaths: string[]): string {
  if (!output) return "";
  const boundary = output.indexOf("\0\0diff --git ");
  if (boundary < 0) throw new AccessError("Git diff cannot be verified", 403);
  const records = output.slice(0, boundary).split("\0");
  const allowed = new Set(allowedPaths);
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    if (!header || !/^:[0-7]{6} [0-7]{6} [0-9a-f]{7,64} [0-9a-f]{7,64} [A-Z][0-9]*$/.test(header)) {
      throw new AccessError("Invalid Git diff metadata", 403);
    }
    const oldPath = records[index++];
    const renamed = / [RC][0-9]*$/.test(header);
    const newPath = renamed ? records[index++] : oldPath;
    if (!oldPath || !newPath || !allowed.has(oldPath) || !allowed.has(newPath)
      || isProtectedPath(oldPath) || isProtectedPath(newPath)) {
      throw new AccessError("Git diff includes an inaccessible path", 403);
    }
  }
  return output.slice(boundary + 2);
}
function quoteDiffPath(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  if (bytes.every(byte => byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c)) {
    return path;
  }
  return '"' + Array.from(bytes, byte => byte === 0x22 ? '\\"'
    : byte === 0x5c ? "\\\\" : byte === 0x09 ? "\\t" : byte === 0x0a ? "\\n"
    : byte === 0x0d ? "\\r" : byte < 0x20 || byte >= 0x7f
      ? "\\" + byte.toString(8).padStart(3, "0") : String.fromCharCode(byte)).join("") + '"';
}
export async function getDiff(repo: Repository, path: string, scope: "staged" | "unstaged" | "untracked") {
  validatePath(path);
  if (scope === "untracked") {
    const status = await getStatus(repo);
    if (!status.changes.some(c => c.path === path && c.untracked)) throw new AccessError("Not an untracked file", 404);
    const content = await readRepoFile(repo, path);
    const lines = content.length ? content.split("\n") : [];
    const hasFinalNewline = content.endsWith("\n");
    if (hasFinalNewline) lines.pop();
    const count = lines.length;
    const hunk = count ? "@@ -0,0 +1," + count + " @@\n" + lines.map(line => "+" + line).join("\n")
      + "\n" + (hasFinalNewline ? "" : "\\ No newline at end of file\n") : "";
    const newPath = quoteDiffPath("b/" + path);
    return "diff --git " + quoteDiffPath("a/" + path) + " " + newPath
      + "\nnew file mode 100644\n--- /dev/null\n+++ " + newPath + "\n" + hunk;
  }
  const status = await getStatus(repo);
  const change = status.changes.find(item => item.path === path
    && (scope === "staged" ? item.staged : item.unstaged));
  if (!change) throw new AccessError("No accessible changes for that path and scope", 404);
  const previousPath = change.previousPath ? validatePath(change.previousPath) : null;
  const output = await execRepoGit(repo, ["diff", "--no-ext-diff", "--no-textconv",
    previousPath ? "--find-renames" : "--no-renames", "--raw", "-z", "--patch", "--unified=3",
    ...(scope === "staged" ? ["--cached"] : []), "--",
    ...(previousPath ? [previousPath] : []), path]);
  return verifiedDiff(output, previousPath ? [previousPath, path] : [path]);
}
const COMMIT_PAGE_SIZE = 30;
export async function getCommits(repo: Repository, cursor?: string) {
  let anchor: string;
  let offset = 0;
  if (cursor === undefined) {
    const { head } = await getStatus(repo);
    if (!head) return { commits: [], nextCursor: null };
    anchor = head;
  } else {
    const parsed = /^([0-9a-f]{40,64}):(\d+)$/i.exec(cursor);
    if (!parsed) throw new AccessError("Invalid commit cursor");
    anchor = parsed[1]!;
    offset = Number(parsed[2]);
    if (!Number.isSafeInteger(offset) || offset < 1 || offset > 1_000_000) {
      throw new AccessError("Invalid commit cursor");
    }
    await requireReachableCommit(repo, anchor);
  }
  const raw = await execRepoGit(repo, [
    "log", "-z", anchor, "--max-count=" + (COMMIT_PAGE_SIZE + 1),
    "--skip=" + offset, "--format=%H%x00%s%x00%an%x00%aI"
  ]);
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 4 !== 0) throw new AccessError("Invalid Git history", 500);
  const results = [];
  for (let i = 0; i < fields.length; i += 4) {
    const [hash, subject, author, date] = fields.slice(i, i + 4);
    if (!/^[0-9a-f]{40,64}$/i.test(hash ?? "") || !date) {
      throw new AccessError("Invalid Git history", 500);
    }
    results.push({ hash: hash!, subject: subject!, author: author!, date: date! });
  }
  const commits = results.slice(0, COMMIT_PAGE_SIZE);
  return {
    commits,
    nextCursor: results.length > COMMIT_PAGE_SIZE
      ? anchor + ":" + (offset + COMMIT_PAGE_SIZE) : null
  };
}
async function requireReachableCommit(repo: Repository, hash: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new AccessError("Invalid commit hash");
  try {
    await execRepoGit(repo, ["merge-base", "--is-ancestor", hash, "HEAD"]);
  } catch (error) {
    if (error instanceof AccessError) throw error;
    const code = (error as { code?: number }).code;
    const missing = code === 1 || code === 128 &&
      /not a valid commit name|not a valid object name/i.test(
        String((error as { stderr?: unknown }).stderr ?? ""));
    if (missing) throw new AccessError("Commit not in current history", 404);
    throw error;
  }
}
async function commitParents(repo: Repository, hash: string): Promise<string[]> {
  await requireReachableCommit(repo, hash);
  const parents = (await execRepoGit(repo, ["rev-list", "--parents", "-n", "1", hash]))
    .trim().split(/\s+/);
  if (parents[0]?.toLowerCase() !== hash.toLowerCase()) {
    throw new AccessError("Commit not found", 404);
  }
  return parents.slice(1);
}
type CommitChange = { path: string; previousPath?: string };
async function commitChanges(repo: Repository, hash: string, parents: string[]): Promise<CommitChange[]> {
  const raw = parents[0]
    ? await execRepoGit(repo, ["diff", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--name-status", "-z", parents[0], hash, "--"])
    : await execRepoGit(repo, ["diff-tree", "--root", "--no-commit-id",
      "--name-status", "-r", "-z", hash]);
  const fields = raw.split("\0");
  const changes: CommitChange[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!;
    if (!/^[A-Z][0-9]*$/.test(status)) throw new AccessError("Invalid commit change status", 500);
    const previousPath = /^[RC]/.test(status) ? fields[i++] : undefined;
    const path = fields[i++];
    if (!path) throw new AccessError("Invalid commit change path", 500);
    if (!isProtectedPath(path) && (!previousPath || !isProtectedPath(previousPath))) {
      changes.push({ path, ...(previousPath ? { previousPath } : {}) });
    }
  }
  return changes;
}
export async function getCommitDiff(repo: Repository, hash: string, path: string) {
  validatePath(path);
  const parents = await commitParents(repo, hash);
  const change = (await commitChanges(repo, hash, parents)).find(item => item.path === path);
  if (!change) return "";
  const options = ["--no-ext-diff", "--no-textconv",
    change.previousPath ? "--find-renames" : "--no-renames",
    "--raw", "-z", "--patch", "--unified=3"];
  const paths = change.previousPath ? [validatePath(change.previousPath), path] : [path];
  const output = parents[0]
    ? await execRepoGit(repo, ["diff", ...options, parents[0], hash, "--", ...paths])
    : await execRepoGit(repo, ["show", "--format=", ...options, hash, "--", ...paths]);
  return verifiedDiff(output, paths);
}
async function readGitBlob(repo: Repository, objectID: string): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/i.test(objectID)) throw new AccessError("Invalid Git object");
  const size = Number((await execRepoGit(repo, ["cat-file", "-s", objectID])).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) {
    throw new AccessError("File too large", 413);
  }
  const content = await execRepoGit(repo, ["cat-file", "blob", objectID]);
  if (content.includes("\0")) throw new AccessError("Binary file cannot be rendered", 415);
  return content;
}
export async function readIndexFile(repo: Repository, path: string): Promise<string | null> {
  validatePath(path);
  const output = await execRepoGit(repo, ["ls-files", "--stage", "-z", "--", path]);
  const entry = output.split("\0").find(Boolean);
  if (!entry) return null;
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$/s.exec(entry);
  if (!match || match[3] !== path || !["100644", "100755"].includes(match[1] ?? "")) {
    throw new AccessError("Not a regular indexed file", 403);
  }
  return readGitBlob(repo, match[2]!);
}
export async function readFileSnapshot(
  repo: Repository, path: string, revision: "worktree" | "index"
): Promise<string | null> {
  if (revision === "index") return readIndexFile(repo, path);
  validatePath(path);
  await safePath(repo.path);
  try {
    return await readRepoFile(repo, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await safePath(repo.path);
      return null;
    }
    throw error;
  }
}
export async function getCommitFile(repo: Repository, hash: string, path: string): Promise<string | null> {
  await requireReachableCommit(repo, hash);
  validatePath(path);
  const tree = await execRepoGit(repo, ["ls-tree", "-z", "-l", hash, "--", path]);
  const entry = tree.split("\0").find(Boolean);
  if (!entry) return null;
  const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/s.exec(entry);
  if (!match || match[4] !== path || !["100644", "100755"].includes(match[1] ?? "")) {
    throw new AccessError("Not a regular file in commit", 403);
  }
  return readGitBlob(repo, match[2]!);
}
export async function getCommitFiles(repo: Repository, hash: string): Promise<string[]> {
  const parents = await commitParents(repo, hash);
  return (await commitChanges(repo, hash, parents)).map(change => change.path);
}

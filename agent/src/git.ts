import { execFile } from "node:child_process";
import { executeGit, GIT_PARALLELISM } from "./git-executor.js";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Repository } from "./config.js";

const exec = promisify(execFile);
const MAX_GIT = 2 * 1024 * 1024;
const MAX_FILE = 512 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const protectedPart = /^(?:\.git|\.env(?:\..*)?|\.envrc|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa(?:_sk)?|ed25519(?:_sk)?|xmss)(?:[._~-](?!pub$)[^/\\]*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
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
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "",
    GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };
}

// Git normally applies the user's text conversion settings before comparing files.
// The restricted Git environment below intentionally ignores untrusted global/system
// configuration. Read only the two safe EOL keys from the effective host settings,
// then reapply those exact values without re-enabling hooks, filters or Git includes.
const textOptionCache = new Map<string, { until: number; options: Promise<string[]> }>();
async function gitTextOptions(root: string): Promise<string[]> {
  const cached = textOptionCache.get(root);
  if (cached && cached.until > Date.now()) return cached.options;
  const options = (async () => {
    const env = gitEnvironment();
    delete env.GIT_CONFIG_NOSYSTEM;
    delete env.GIT_CONFIG_GLOBAL;
    let output: string;
    try {
      const result = await exec("git", ["config", "--get-regexp",
        "^core\\.(autocrlf|eol)$"], {
        cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
        windowsHide: true, env
      });
      output = result.stdout;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return [];
      throw error;
    }
    const values = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      if (separator === -1) continue;
      const key = line.slice(0, separator).toLowerCase();
      const raw = line.slice(separator + 1).trim().toLowerCase();
      if (key === "core.autocrlf") {
        const value = ["true", "yes", "on"].includes(raw) ? "true"
          : ["false", "no", "off"].includes(raw) ? "false" : raw;
        if (["true", "false", "input"].includes(value)) values.set(key, value);
      } else if (key === "core.eol" && ["lf", "crlf", "native"].includes(raw)) {
        values.set(key, raw);
      }
    }
    return [...values].flatMap(([key, value]) => ["-c", key + "=" + value]);
  })();
  if (textOptionCache.size >= 64) textOptionCache.delete(textOptionCache.keys().next().value!);
  textOptionCache.set(root, { until: Date.now() + 30_000, options });
  try { return await options; }
  catch (error) { textOptionCache.delete(root); throw error; }
}
// A repository may define executable clean/process filters in local Git config.
// Read those driver names without executing Git worktree operations, then disable
// every discovered driver for the single read-only command.
async function disabledGitFilters(root: string): Promise<string[]> {
  let output: string;
  try {
    const result = await exec("git", ["config", "--local", "--includes",
      "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], {
      cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
      windowsHide: true, env: gitEnvironment()
    });
    output = result.stdout;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
  const drivers = new Set<string>();
  for (const key of output.split("\0")) {
    const match = /^filter\.(.+)\.(?:clean|process)$/i.exec(key);
    if (match) drivers.add(match[1]!);
  }
  return [...drivers].flatMap(name => [
    "-c", `filter.${name}.clean=`,
    "-c", `filter.${name}.process=`,
    "-c", `filter.${name}.required=false`
  ]);
}
async function runGit(
  cwd: string, args: string[], workTreeRoot?: string, binary = false
): Promise<string | Buffer> {
  return executeGit(async signal => {
    signal.throwIfAborted();
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
    const [textOptions, disabledFilters] = await Promise.all([
      gitTextOptions(root), disabledGitFilters(root)
    ]);
    signal.throwIfAborted();
    const result = await exec("git", [
      ...textOptions, ...disabledFilters,
      ...(workTree ? ["-c", "core.bare=false", "--work-tree=" + workTree] : []),
      "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.fsmonitor=false",
      "--no-pager", ...args
    ], {
      cwd: root, encoding: binary ? "buffer" : "utf8", timeout: 5000,
      maxBuffer: binary ? MAX_IMAGE + 65536 : MAX_GIT, windowsHide: true,
      env: gitEnvironment(), signal
    });
    return result.stdout;
  });
}
export async function execGit(cwd: string, args: string[], workTreeRoot?: string): Promise<string> {
  return await runGit(cwd, args, workTreeRoot) as string;
}
function execRepoGit(repo: Repository, args: string[]): Promise<string> {
  return execGit(repo.path, args, repo.path);
}
function execRepoGitBytes(repo: Repository, args: string[]): Promise<Buffer> {
  return runGit(repo.path, args, repo.path, true) as Promise<Buffer>;
}
export interface Change {
  path: string; previousPath?: string;
  stagedKind: string | null; workingKind: string | null;
}
export interface RepoStatus { branch: string; head: string | null; changes: Change[] }
function statusKind(state: string): string {
  if (state === "R") return "renamed";
  if (state === "C") return "copied";
  if (state === "D") return "deleted";
  if (state === "A") return "added";
  return "modified";
}
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
      if (!isProtectedPath(path)) changes.push({
        path, stagedKind: null, workingKind: "untracked"
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const path = record.split(" ").slice(10).join(" ");
      if (path && !isProtectedPath(path)) {
        changes.push({ path, stagedKind: null, workingKind: "conflicted" });
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
    changes.push({
      path, ...(previousPath ? { previousPath } : {}),
      stagedKind: xy[0] !== "." ? statusKind(xy[0]!) : null,
      workingKind: xy[1] !== "." ? statusKind(xy[1]!) : null
    });
  }
  return { branch, head, changes };
}
export async function getStatus(repo: Repository, includeUntracked = true): Promise<RepoStatus> {
  return parseStatus(await execRepoGit(repo, [
    "status", "--porcelain=v2", "-z", "--branch",
    includeUntracked ? "--untracked-files=all" : "--untracked-files=no"
  ]));
}
type RepoIssue = "unavailable" | "temporary";
export async function getRepositorySummaries(repositories: Repository[]) {
  const summaries: Array<{ repo: Repository; status: RepoStatus | null; issue: RepoIssue | null }> = [];
  for (let index = 0; index < repositories.length; index += GIT_PARALLELISM) {
    const batch = await Promise.all(repositories.slice(index, index + GIT_PARALLELISM)
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
async function readRepoBytes(repo: Repository, path: string, limit: number): Promise<Buffer> {
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
    if (opened.size > limit) throw new AccessError("File too large", 413);
    const buffer = Buffer.allocUnsafe(Math.min(opened.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new AccessError("File too large", 413);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export async function readRepoFile(repo: Repository, path: string): Promise<string> {
  const bytes = await readRepoBytes(repo, path, MAX_FILE);
  if (bytes.includes(0)) throw new AccessError("Binary file cannot be rendered", 415);
  return bytes.toString("utf8");
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
      const entries: TreeEntry[] = [];
      let count = 0;
      for await (const item of await opendir(root)) {
        if (++count > MAX_TREE_ENTRIES) throw new AccessError("Directory too large", 413);
        if (item.isSymbolicLink() || isProtectedPath(item.name)) continue;
        entries.push({
          name: item.name, path: path ? path + "/" + item.name : item.name,
          directory: item.isDirectory()
        });
      }
      entries.sort((a, b) => Number(b.directory) - Number(a.directory)
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
export async function getDiff(
  repo: Repository, path: string, scope: "staged" | "unstaged" | "untracked",
  full = false
) {
  validatePath(path);
  if (scope === "untracked") {
    const status = await getStatus(repo);
    if (!status.changes.some(c => c.path === path && c.workingKind === "untracked")) throw new AccessError("Not an untracked file", 404);
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
  const status = await getStatus(repo, false);
  const change = status.changes.find(item => item.path === path
    && (scope === "staged" ? item.stagedKind !== null
      : item.workingKind !== null && item.workingKind !== "conflicted"));
  if (!change) throw new AccessError("No accessible changes for that path and scope", 404);
  const previousPath = change.previousPath ? validatePath(change.previousPath) : null;
  const output = await execRepoGit(repo, ["diff", "--no-ext-diff", "--no-textconv",
    previousPath ? "--find-renames" : "--no-renames", "--raw", "-z", "--patch",
    full ? "--unified=999999" : "--unified=3",
    ...(scope === "staged" ? ["--cached"] : []), "--",
    ...(previousPath ? [previousPath] : []), path]);
  return verifiedDiff(output, previousPath ? [previousPath, path] : [path]);
}
const COMMIT_PAGE_SIZE = 30;
export async function getCommits(repo: Repository, cursor?: string) {
  let anchor: string;
  let offset = 0;
  if (cursor === undefined) {
    const { head } = await getStatus(repo, false);
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
type CommitChange = { path: string; previousPath?: string; deleted: boolean };
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
      changes.push({ path, ...(previousPath ? { previousPath } : {}), deleted: status === "D" });
    }
  }
  return changes;
}
export async function getCommitDiff(repo: Repository, hash: string, path: string, full = false) {
  validatePath(path);
  const parents = await commitParents(repo, hash);
  const change = (await commitChanges(repo, hash, parents)).find(item => item.path === path);
  if (!change) return "";
  const options = ["--no-ext-diff", "--no-textconv",
    change.previousPath ? "--find-renames" : "--no-renames",
    "--raw", "-z", "--patch", full ? "--unified=999999" : "--unified=3"];
  const paths = change.previousPath ? [validatePath(change.previousPath), path] : [path];
  const output = parents[0]
    ? await execRepoGit(repo, ["diff", ...options, parents[0], hash, "--", ...paths])
    : await execRepoGit(repo, ["show", "--format=", ...options, hash, "--", ...paths]);
  return verifiedDiff(output, paths);
}
async function readGitBlobBytes(
  repo: Repository, objectID: string, limit: number
): Promise<Buffer> {
  if (!/^[0-9a-f]{40,64}$/i.test(objectID)) throw new AccessError("Invalid Git object");
  const size = Number((await execRepoGit(repo, ["cat-file", "-s", objectID])).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new AccessError("File too large", 413);
  }
  const bytes = await execRepoGitBytes(repo, ["cat-file", "blob", objectID]);
  if (bytes.length !== size) throw new AccessError("Git object size mismatch", 500);
  return bytes;
}
async function readGitBlob(repo: Repository, objectID: string): Promise<string> {
  const bytes = await readGitBlobBytes(repo, objectID, MAX_FILE);
  if (bytes.includes(0)) throw new AccessError("Binary file cannot be rendered", 415);
  return bytes.toString("utf8");
}
async function indexBlobID(repo: Repository, path: string): Promise<string | null> {
  validatePath(path);
  const output = await execRepoGit(repo, ["ls-files", "--stage", "-z", "--", path]);
  const entry = output.split("\0").find(Boolean);
  if (!entry) return null;
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$/s.exec(entry);
  if (!match || match[3] !== path || !["100644", "100755"].includes(match[1] ?? "")) {
    throw new AccessError("Not a regular indexed file", 403);
  }
  return match[2]!;
}
export async function readIndexFile(repo: Repository, path: string): Promise<string | null> {
  const objectID = await indexBlobID(repo, path);
  return objectID ? readGitBlob(repo, objectID) : null;
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
async function commitBlobID(repo: Repository, hash: string, path: string): Promise<string | null> {
  await requireReachableCommit(repo, hash);
  validatePath(path);
  const tree = await execRepoGit(repo, ["ls-tree", "-z", "-l", hash, "--", path]);
  const entry = tree.split("\0").find(Boolean);
  if (!entry) return null;
  const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/s.exec(entry);
  if (!match || match[4] !== path || !["100644", "100755"].includes(match[1] ?? "")) {
    throw new AccessError("Not a regular file in commit", 403);
  }
  return match[2]!;
}
export async function getCommitFile(repo: Repository, hash: string, path: string): Promise<string | null> {
  const objectID = await commitBlobID(repo, hash, path);
  return objectID ? readGitBlob(repo, objectID) : null;
}
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp"
};
function imageContentType(path: string, bytes: Buffer): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const type = IMAGE_TYPES[extension];
  if (!type) throw new AccessError("Image preview is not supported for this format", 415);
  const valid = type === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : type === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : type === "image/gif"
        ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF"
          && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new AccessError("Invalid image format", 415);
  return type;
}
export async function readImagePreview(
  repo: Repository, path: string, revision: "worktree" | "index" = "worktree",
  commit?: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  validatePath(path);
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!IMAGE_TYPES[extension]) {
    throw new AccessError("Image preview is not supported for this format", 415);
  }
  let bytes: Buffer;
  if (commit !== undefined || revision === "index") {
    const objectID = commit !== undefined
      ? await commitBlobID(repo, commit, path) : await indexBlobID(repo, path);
    if (!objectID) return null;
    bytes = await readGitBlobBytes(repo, objectID, MAX_IMAGE);
  } else {
    try { bytes = await readRepoBytes(repo, path, MAX_IMAGE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return { bytes, contentType: imageContentType(path, bytes) };
}
export async function getCommitFileChanges(repo: Repository, hash: string): Promise<CommitChange[]> {
  const parents = await commitParents(repo, hash);
  return commitChanges(repo, hash, parents);
}

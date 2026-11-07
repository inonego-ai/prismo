import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { addRepository, listRepositories, removeRepository, repositoryRoot } from "../config.js";
import { createApp } from "../api.js";
import { getCommitDiff, getCommitFile, getCommitFileChanges, getCommits, getDiff, getRepositorySummaries, getStatus, parseStatus, readFileSnapshot, readImagePreview, readRepoFile, TreeStore } from "../git.js";
import { PairingStore } from "../pairing.js";
import { UpdateStore } from "../updates.js";

const exec = promisify(execFile);
const tempRoot = await realpath(tmpdir());
const TEST_PEER = "a".repeat(64);
const TEST_TOKEN = "A".repeat(43);
async function git(cwd: string, args: string[]) {
  await exec("git", args, { cwd, timeout: 10000 });
}
test("read-only repository registration and API behavior", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-test-"));
  const repoPath = join(base, "repo");
  process.env.PRISMO_CONFIG_DIR = join(base, "settings");
  const pairing = new PairingStore();
  const app = createApp(pairing, new UpdateStore(), async () => true);
  let authToken = "";
  const inject = (request: { method: "GET"; url: string }) => app.inject({
    ...request, headers: { authorization: "Bearer " + authToken, "x-prismo-peer": TEST_PEER }
  });
  try {
    await git(base, ["init", "-b", "main", repoPath]);
    await writeFile(join(repoPath, "hello.ts"), "const before = 1;\n");
    await git(repoPath, ["add", "hello.ts"]);
    await git(repoPath, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Initial"]);
    await writeFile(join(repoPath, "hello.ts"), "const after = 2;\n");
    await writeFile(join(repoPath, "new.ts"), "export const item = true;\n");
    await writeFile(join(repoPath, ".env"), "TOKEN=secret\n");
    const registered = await addRepository(repoPath);
    assert.equal((await addRepository(repoPath)).id, registered.id);
    assert.equal((await listRepositories()).length, 1);
    const status = await getStatus(registered);
    assert.equal(status.branch, "main");
    assert.equal(status.changes.some(item => item.path === "hello.ts"
      && item.workingKind === "modified"), true);
    const untracked = status.changes.find(item => item.path === "new.ts");
    assert.equal(untracked?.stagedKind, null);
    assert.equal(untracked?.workingKind, "untracked");
    assert.deepEqual(Object.keys(untracked ?? {}).sort(), ["path", "stagedKind", "workingKind"]);
    assert.equal(status.changes.some(item => item.path === ".env"), false);
    const unauthorized = await inject({ method: "GET", url: "/api/v1/repositories" });
    assert.equal(unauthorized.statusCode, 401);
    const code = pairing.issue().secret;
    const pairingResponse = await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER } });
    assert.equal(pairingResponse.statusCode, 200);
    assert.equal(pairingResponse.json().paired, true);
    authToken = TEST_TOKEN;
    assert.equal(pairing.current(), null);
    assert.equal((await inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: "B".repeat(43) },
      headers: { "x-prismo-peer": TEST_PEER } })).statusCode, 401);
    const listing = await inject({ method: "GET", url: "/api/v1/repositories" });
    assert.deepEqual(listing.json().repositories, [{ id: registered.id, name: registered.name }]);
    const tree = await inject({ method: "GET", url: "/api/v1/repositories/" + registered.id + "/tree" });
    assert.equal(tree.json().entries.some((item: { path: string }) => item.path === ".env"), false);
    const invalidCursor = await inject({ method: "GET", url: "/api/v1/repositories/" + registered.id + "/tree?cursor=invalid" });
    assert.equal(invalidCursor.statusCode, 400);
    const health = await inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().service, "Prismo");
    const prefix = "/api/v1/repositories/" + registered.id;
    const history = await inject({ method: "GET", url: prefix + "/commits" });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().nextCursor, null);
    assert.equal((await inject({ method: "GET", url: prefix + "/commits?cursor=invalid" })).statusCode, 400);
    const hash = history.json().commits[0].hash as string;
    const changedInCommit = await inject({ method: "GET", url: prefix +
      "/commits/" + hash + "/files" });
    assert.deepEqual(changedInCommit.json().files, ["hello.ts"]);
    assert.deepEqual(changedInCommit.json().deletedFiles, []);
    const historicalFile = await inject({ method: "GET", url: prefix +
      "/commits/" + hash + "/file?path=hello.ts" });
    assert.equal(historicalFile.json().content, "const before = 1;\n");
    const historicalDiff = await inject({ method: "GET", url: prefix +
      "/commits/" + hash + "/diff?path=hello.ts" });
    assert.match(historicalDiff.json().diff, /\+const before/);
    const response = await inject({ method: "GET", url: prefix + "/status" });
    assert.equal(response.statusCode, 200);
    const file = await inject({ method: "GET", url: prefix + "/file?path=hello.ts" });
    assert.equal(file.json().content, "const after = 2;\n");
    const diff = await inject({ method: "GET", url: prefix +
      "/diff?scope=unstaged&path=hello.ts" });
    assert.match(diff.json().diff, /\+const after/);
    const newDiff = await inject({ method: "GET", url: prefix +
      "/diff?scope=untracked&path=new.ts" });
    assert.match(newDiff.json().diff, /new file mode/);
    const secret = await inject({ method: "GET", url: prefix + "/file?path=.env" });
    assert.equal(secret.statusCode, 403);
    const traversal = await inject({ method: "GET", url: prefix +
      "/file?path=..%2Fhello.ts" });
    assert.notEqual(traversal.statusCode, 200);
    const windowsAlias = await inject({ method: "GET", url: prefix +
      "/file?path=.env." });
    assert.equal(windowsAlias.statusCode, 403);
    await git(repoPath, ["add", "hello.ts"]);
    await writeFile(join(repoPath, "hello.ts"), "const working = 3;\n");
    const indexed = await inject({ method: "GET", url: prefix + "/file?path=hello.ts&revision=index" });
    assert.equal(indexed.json().content, "const after = 2;\n");
    const working = await inject({ method: "GET", url: prefix + "/file?path=hello.ts" });
    assert.equal(working.json().content, "const working = 3;\n");
    const staged = await inject({ method: "GET", url: prefix +
      "/diff?scope=staged&path=hello.ts" });
    assert.match(staged.json().diff, /const after/);
    await unlink(join(repoPath, "hello.ts"));
    const missingWorktree = await inject({ method: "GET", url: prefix + "/file?path=hello.ts" });
    assert.equal(missingWorktree.statusCode, 200);
    assert.equal(missingWorktree.json().content, null);
    const stillIndexed = await inject({ method: "GET", url: prefix + "/file?path=hello.ts&revision=index" });
    assert.equal(stillIndexed.json().content, "const after = 2;\n");
    await git(repoPath, ["add", "-u", "hello.ts"]);
    const missingIndex = await inject({ method: "GET", url: prefix + "/file?path=hello.ts&revision=index" });
    assert.equal(missingIndex.statusCode, 200);
    assert.equal(missingIndex.json().content, null);
    await git(repoPath, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Delete file"]);
    const { stdout: deletedHash } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const deletedListing = await inject({ method: "GET", url: prefix +
      "/commits/" + deletedHash.trim() + "/files" });
    assert.deepEqual(deletedListing.json().files, ["hello.ts"]);
    assert.deepEqual(deletedListing.json().deletedFiles, ["hello.ts"]);
    const deletedAtCommit = await inject({ method: "GET", url: prefix +
      "/commits/" + deletedHash.trim() + "/file?path=hello.ts" });
    assert.equal(deletedAtCommit.statusCode, 200);
    assert.equal(deletedAtCommit.json().content, null);
    const deletedDiff = await inject({ method: "GET", url: prefix +
      "/commits/" + deletedHash.trim() + "/diff?path=hello.ts" });
    assert.match(deletedDiff.json().diff, /deleted file mode/);
    assert.equal(await removeRepository(repoPath), false);
    assert.equal((await listRepositories()).length, 1);
    assert.equal(await removeRepository(registered.id), true);
    assert.equal(await removeRepository(registered.id), false);
    assert.equal((await listRepositories()).length, 0);
    const many = join(repoPath, "many");
    await mkdir(many);
    await Promise.all(Array.from({ length: 203 }, (_, index) =>
      writeFile(join(many, "file-" + String(index).padStart(3, "0") + ".txt"), "")));
    const trees = new TreeStore();
    const firstPage = await trees.list(registered, "many");
    assert.equal(firstPage.entries.length, 200);
    assert.ok(firstPage.nextCursor);
    await writeFile(join(many, "file-after-snapshot.txt"), "new");
    const secondPage = await trees.list(registered, "many", firstPage.nextCursor!);
    assert.equal(secondPage.entries.length, 3);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(new Set([...firstPage.entries, ...secondPage.entries].map(x => x.path)).size, 203);
  } finally {
    await app.close();
    delete process.env.PRISMO_CONFIG_DIR;
    await rm(base, { recursive: true, force: true });
  }
});

test("subfolder registration discovers the real root despite local worktree redirection", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-subfolder-register-"));
  const path = join(base, "repo");
  const subfolder = join(path, "nested", "folder");
  const outside = join(base, "outside");
  const previousConfigDir = process.env.PRISMO_CONFIG_DIR;
  try {
    await git(base, ["init", "-b", "main", path]);
    await mkdir(subfolder, { recursive: true });
    await mkdir(outside);
    await writeFile(join(path, "inside.txt"), "inside\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Inside"]);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    await git(path, ["config", "core.worktree", outside]);
    await git(path, ["config", "core.bare", "true"]);
    process.env.PRISMO_CONFIG_DIR = join(base, "settings");

    assert.equal(await repositoryRoot(subfolder), path);
    const registered = await addRepository(subfolder);
    assert.equal(registered.path, path);
    const status = await getStatus(registered);
    assert.equal(status.branch, "main");
    assert.deepEqual(status.changes, []);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PRISMO_CONFIG_DIR;
    else process.env.PRISMO_CONFIG_DIR = previousConfigDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("repository root replacement cannot redirect root listings or file reads", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-root-link-"));
  const root = join(base, "repo");
  const moved = join(base, "original");
  const outside = join(base, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "public.txt"), "public");
    await writeFile(join(outside, "private.txt"), "private");
    const repo = { id: "root-check", name: "repo", path: root };
    const trees = new TreeStore();
    const initial = await trees.list(repo);
    assert.deepEqual(initial.entries.map(item => item.name), ["public.txt"]);
    await rename(root, moved);
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(trees.list(repo), { statusCode: 403 });
    await assert.rejects(readRepoFile(repo, "private.txt"), { statusCode: 403 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Git path arguments are literal and cannot expose protected files", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-literal-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    await writeFile(join(path, ".env"), "SECRET=value\n");
    await writeFile(join(path, ".npmrc"), "//registry:token=secret\n");
    await writeFile(join(path, ".netrc"), "machine example login a password b\n");
    const protectedNames = [".envrc", "id_ecdsa", "id_ecdsa_sk", "id_ed25519_sk", "id_xmss"];
    for (const name of protectedNames) await writeFile(join(path, name), "PRIVATE KEY\n");
    await writeFile(join(path, "entry[1].txt"), "before\n");
    await writeFile(join(path, "entry1.txt"), "unrelated\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Initial"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    const repo = { id: "literal", name: "repo", path };
    assert.equal((await getCommitDiff(repo, stdout.trim(), ".e[n]v")).trim(), "");
    assert.deepEqual((await getCommitFileChanges(repo, stdout.trim())).map(change => change.path),
      ["entry1.txt", "entry[1].txt"]);
    await assert.rejects(getCommitFile(repo, stdout.trim(), ".npmrc"), { statusCode: 403 });
    await assert.rejects(getCommitFile(repo, stdout.trim(), ".netrc"), { statusCode: 403 });
    for (const name of protectedNames) {
      await assert.rejects(getCommitFile(repo, stdout.trim(), name), { statusCode: 403 });
      await assert.rejects(readRepoFile(repo, name), { statusCode: 403 });
    }
    const visible = (await new TreeStore().list(repo)).entries.map(entry => entry.name);
    assert.equal(protectedNames.some(name => visible.includes(name)), false);
    assert.equal(await getCommitFile(repo, stdout.trim(), "entry[1].txt"), "before\n");
    await writeFile(join(path, "entry[1].txt"), "after\n");
    const diff = await getDiff(repo, "entry[1].txt", "unstaged");
    assert.match(diff, /\+after/);
    assert.doesNotMatch(diff, /unrelated|SECRET/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("renamed files keep both paths in working and historical diffs", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-rename-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const original = Array.from({ length: 12 }, (_, i) => "line " + i).join("\n") + "\n";
    await writeFile(join(path, "before.ts"), original);
    await git(path, ["add", "before.ts"]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Base"]);
    await git(path, ["mv", "before.ts", "after.ts"]);
    await writeFile(join(path, "after.ts"), original.replace("line 5", "line five"));
    await git(path, ["add", "after.ts"]);
    const repo = { id: "rename", name: "repo", path };
    const status = await getStatus(repo);
    assert.equal(status.changes[0]?.stagedKind, "renamed");
    assert.equal(status.changes[0]?.previousPath, "before.ts");
    const staged = await getDiff(repo, "after.ts", "staged");
    assert.match(staged, /rename from before\.ts/);
    assert.match(staged, /rename to after\.ts/);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Rename"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    assert.deepEqual((await getCommitFileChanges(repo, stdout.trim())).map(change => change.path),
      ["after.ts"]);
    const historical = await getCommitDiff(repo, stdout.trim(), "after.ts");
    assert.match(historical, /rename from before\.ts/);
    assert.match(historical, /rename to after\.ts/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("staged rename remains a rename after its working file is deleted", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-rename-rd-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const content = Array.from({ length: 20 }, (_, i) => "line " + i).join("\n") + "\n";
    await writeFile(join(path, "before.ts"), content);
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Base"]);
    await git(path, ["mv", "before.ts", "after.ts"]);
    await unlink(join(path, "after.ts"));
    const repo = { id: "rd", name: "repo", path };
    const entry = (await getStatus(repo)).changes.find(item => item.path === "after.ts");
    assert.equal(entry?.stagedKind, "renamed");
    assert.equal(entry?.previousPath, "before.ts");
    assert.equal(entry?.workingKind, "deleted");
    assert.match(await getDiff(repo, "after.ts", "staged"), /rename from before\.ts/);
    assert.match(await getDiff(repo, "after.ts", "unstaged"), /deleted file mode/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("unstaged rename status retains both paths and serves its diff", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-unstaged-rename-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const content = Array.from({ length: 20 }, (_, i) => "line " + i).join("\n") + "\n";
    await writeFile(join(path, "before.ts"), content);
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Base"]);
    await rename(join(path, "before.ts"), join(path, "after.ts"));
    await git(path, ["add", "-N", "after.ts"]);
    const repo = { id: "unstaged-rename", name: "repo", path };
    const status = await getStatus(repo);
    const change = status.changes.find(item => item.path === "after.ts");
    assert.equal(change?.workingKind, "renamed");
    assert.equal(change?.previousPath, "before.ts");
    assert.equal(change?.stagedKind, null);
    const diff = await getDiff(repo, "after.ts", "unstaged");
    assert.match(diff, /rename from before\.ts/);
    assert.match(diff, /rename to after\.ts/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Git execution ignores inherited repository and config selectors", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-git-env-"));
  const selected = join(base, "selected");
  const alternate = join(base, "alternate");
  const envNames = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_EXEC_PATH",
    "GIT_CEILING_DIRECTORIES", "GIT_PREFIX", "GIT_REPLACE_REF_BASE"];
  const original = new Map(envNames.map(name => [name, process.env[name]]));
  try {
    await git(base, ["init", "-b", "main", selected]);
    await git(base, ["init", "-b", "other", alternate]);
    await writeFile(join(selected, "selected.txt"), "selected\n");
    await git(selected, ["add", "."]);
    await git(selected, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Selected"]);
    await writeFile(join(alternate, "alternate.txt"), "alternate\n");
    await git(alternate, ["add", "."]);
    const alternateIndex = join(alternate, ".git", "index");
    const poisonConfig = join(base, "poison.config");
    await writeFile(poisonConfig, "core.bare=true\n");
    process.env.GIT_DIR = join(alternate, ".git");
    process.env.GIT_WORK_TREE = alternate;
    process.env.GIT_INDEX_FILE = alternateIndex;
    process.env.GIT_COMMON_DIR = join(alternate, ".git");
    process.env.GIT_OBJECT_DIRECTORY = join(alternate, ".git", "objects");
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(alternate, ".git", "objects");
    process.env.GIT_NAMESPACE = "injected";
    process.env.GIT_CONFIG = poisonConfig;
    process.env.GIT_CONFIG_GLOBAL = poisonConfig;
    process.env.GIT_CONFIG_SYSTEM = poisonConfig;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.bare";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    process.env.GIT_CONFIG_PARAMETERS = "'core.bare=true'";
    process.env.GIT_EXEC_PATH = join(base, "missing-git-exec");
    process.env.GIT_CEILING_DIRECTORIES = base;
    process.env.GIT_PREFIX = "injected/";
    process.env.GIT_REPLACE_REF_BASE = "refs/injected/replace";
    const status = await getStatus({ id: "selected", name: "selected", path: selected });
    assert.equal(status.branch, "main");
    assert.deepEqual(status.changes, []);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
});

test("repository-local worktree settings cannot redirect Git outside the registered root", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-worktree-config-"));
  const path = join(base, "repo");
  const outside = join(base, "outside");
  try {
    await git(base, ["init", "-b", "main", path]);
    await mkdir(outside);
    await writeFile(join(path, "inside.txt"), "inside\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Inside"]);
    await writeFile(join(outside, "outside.txt"), "private outside data\n");
    await git(path, ["config", "core.worktree", outside]);
    await git(path, ["config", "core.bare", "true"]);

    const repo = { id: "worktree-config", name: "repo", path };
    const status = await getStatus(repo);
    assert.equal(status.branch, "main");
    assert.deepEqual(status.changes, []);
    await assert.rejects(getDiff(repo, "outside.txt", "untracked"), { statusCode: 404 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("untracked diffs quote unusual paths and mark missing final newlines", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-untracked-diff-"));
  const path = join(base, "repo");
  const fileName = "café.ts";
  try {
    await git(base, ["init", "-b", "main", path]);
    await writeFile(join(path, fileName), "line without a final newline");
    const diff = await getDiff({ id: "untracked-diff", name: "repo", path }, fileName, "untracked");
    assert.match(diff, /diff --git "a\/caf\\303\\251\.ts" "b\/caf\\303\\251\.ts"/);
    assert.match(diff, /\+\+\+ "b\/caf\\303\\251\.ts"/);
    assert.match(diff, /\\ No newline at end of file/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("staged and working change kinds remain distinct for one file", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-mixed-status-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    await writeFile(join(path, "example.ts"), "staged\\n");
    await git(path, ["add", "example.ts"]);
    await writeFile(join(path, "example.ts"), "working\\n");
    const status = await getStatus({ id: "mixed-status", name: "repo", path });
    const change = status.changes.find(item => item.path === "example.ts");
    assert.equal(change?.stagedKind, "added");
    assert.equal(change?.workingKind, "modified");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("NUL porcelain parsing preserves newlines and header-like text in filenames", () => {
  const path = "file\n# branch.head injected\nname.txt";
  const status = parseStatus("# branch.oid (initial)\0# branch.head main\0"
    + "? .env\0? " + path + "\0");
  assert.equal(status.branch, "main");
  assert.equal(status.head, null);
  assert.deepEqual(status.changes.map(change => change.path), [path]);
});

test("missing worktree files return null but a missing repository stays an error", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-file-missing-"));
  const path = join(base, "repo");
  const moved = join(base, "repo-moved");
  try {
    await git(base, ["init", "-b", "main", path]);
    await writeFile(join(path, "present.txt"), "present\n");
    const repo = { id: "missing-file", name: "repo", path };
    assert.equal(await readFileSnapshot(repo, "absent.txt", "worktree"), null);
    await rename(path, moved);
    await assert.rejects(readFileSnapshot(repo, "present.txt", "worktree"),
      error => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Git infrastructure errors retain their cause and do not mark valid repositories missing", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-git-errors-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "--allow-empty", "-m", "Base"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    const repo = { id: "error", name: "repo", path };
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = join(base, "no-git-executable");
      await assert.rejects(getCommitFileChanges(repo, stdout.trim()), error => {
        assert.notEqual((error as { statusCode?: number }).statusCode, 404);
        return true;
      });
      const summary = (await getRepositorySummaries([repo]))[0]!;
      assert.equal(summary.status, null);
      assert.equal(summary.issue, "temporary");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    const missing = { id: "missing", name: "missing", path: join(base, "missing") };
    const summary = (await getRepositorySummaries([missing]))[0]!;
    assert.equal(summary.issue, "unavailable");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Git executable failures return server errors rather than missing commits", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-git-api-error-"));
  const path = join(base, "repo");
  const oldConfig = process.env.PRISMO_CONFIG_DIR;
  const oldPath = process.env.PATH;
  try {
    await git(base, ["init", "-b", "main", path]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "--allow-empty", "-m", "Base"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    process.env.PRISMO_CONFIG_DIR = join(base, "config");
    const registered = await addRepository(path);
    const pairing = new PairingStore(join(base, "paired.json"));
    const app = createApp(pairing, new UpdateStore(), async () => true);
    try {
      const code = pairing.issue().secret;
      const paired = await app.inject({
        method: "POST", url: "/api/v1/pair",
        payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER }
      });
      assert.equal(paired.statusCode, 200);
      process.env.PATH = join(base, "no-git-executable");
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/repositories/" + registered.id + "/commits/" + stdout.trim() + "/files",
        headers: { authorization: "Bearer " + TEST_TOKEN, "x-prismo-peer": TEST_PEER }
      });
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().error, "Internal server error");
    } finally {
      await app.close();
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldConfig === undefined) delete process.env.PRISMO_CONFIG_DIR;
    else process.env.PRISMO_CONFIG_DIR = oldConfig;
    await rm(base, { recursive: true, force: true });
  }
});

test("commit endpoints reject hashes outside current HEAD history", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-reachable-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    await writeFile(join(path, "base.txt"), "base\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Base"]);
    const { stdout: mainHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    await git(path, ["checkout", "-b", "hidden"]);
    await writeFile(join(path, "hidden.txt"), "hidden content\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Hidden"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    const hidden = stdout.trim();
    await git(path, ["checkout", "main"]);
    await git(path, ["branch", "-D", "hidden"]);
    const repo = { id: "reachable", name: "repo", path };
    assert.deepEqual((await getCommitFileChanges(repo, mainHead.trim())).map(change => change.path),
      ["base.txt"]);
    await assert.rejects(getCommitFileChanges(repo, hidden), { statusCode: 404 });
    await assert.rejects(getCommitDiff(repo, hidden, "hidden.txt"), { statusCode: 404 });
    await assert.rejects(getCommitFile(repo, hidden, "hidden.txt"), { statusCode: 404 });
    await assert.rejects(getCommits(repo, hidden + ":1"), { statusCode: 404 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Git patches reject protected descendants during directory-to-file replacement", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-diff-privacy-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    await mkdir(join(path, "config"));
    await writeFile(join(path, "config", ".env"), "SECRET=must-not-appear\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Secret directory"]);
    await rm(join(path, "config"), { recursive: true });
    await writeFile(join(path, "config"), "public\n");
    await git(path, ["add", "-A"]);
    const repo = { id: "privacy", name: "repo", path };
    const staged = await getStatus(repo);
    assert.equal(staged.changes.some(item => item.path === "config"), true);
    await assert.rejects(getDiff(repo, "config", "staged"), { statusCode: 403 });
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Replace directory"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    await assert.rejects(getCommitDiff(repo, stdout.trim(), "config"), { statusCode: 403 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pairing attempts are limited per authenticated peer", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-pair-limit-"));
  const pairing = new PairingStore(join(base, "paired.json"));
  const app = createApp(pairing, new UpdateStore(), async () => true);
  try {
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({ method: "POST", url: "/api/v1/pair",
        payload: { code: "invalid", token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER } });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code: "invalid", token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER } })).statusCode, 429);
    const otherPeer = "b".repeat(64);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code: "invalid", token: TEST_TOKEN }, headers: { "x-prismo-peer": otherPeer } })).statusCode, 401);
    const code = pairing.issue().secret;
    const other = await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: "B".repeat(43) }, headers: { "x-prismo-peer": otherPeer } });
    assert.equal(other.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("merge conflicts remain visible without exposing protected paths", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-conflict-"));
  const path = join(base, "repo");
  const file = "source with space.ts";
  const save = async (value: string) => {
    await writeFile(join(path, file), value + "\n");
    await writeFile(join(path, ".env"), "secret-" + value + "\n");
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", value]);
  };
  try {
    await git(base, ["init", "-b", "main", path]);
    await save("base");
    await git(path, ["checkout", "-b", "feature"]);
    await save("feature");
    await git(path, ["checkout", "main"]);
    await save("main");
    await assert.rejects(git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "merge", "feature"]));
    const repo = { id: "conflict", name: "repo", path };
    const status = await getStatus(repo);
    const conflict = status.changes.find(change => change.path === file);
    assert.equal(conflict?.workingKind, "conflicted");
    assert.equal(conflict?.stagedKind, null);
    assert.equal(status.changes.some(change => change.path === ".env"), false);
    assert.match(await readRepoFile(repo, file), /<<<<<<< HEAD/);
    await assert.rejects(getDiff(repo, file, "unstaged"), { statusCode: 404 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("image API requires pairing and streams image bytes without text conversion", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-image-api-"));
  const path = join(base, "repo");
  const original = process.env.PRISMO_CONFIG_DIR;
  process.env.PRISMO_CONFIG_DIR = join(base, "settings");
  const pairing = new PairingStore();
  const app = createApp(pairing, new UpdateStore(), async () => true);
  try {
    await git(base, ["init", "-b", "main", path]);
    const image = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
    await writeFile(join(path, "sample.png"), image);
    const repo = await addRepository(path);
    await app.ready();
    const url = "/api/v1/repositories/" + repo.id + "/image?path=sample.png";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    const code = pairing.issue().secret;
    const token = TEST_TOKEN;
    const response = await app.inject({
      method: "POST", url: "/api/v1/pair", payload: { code, token },
      headers: { "x-prismo-peer": TEST_PEER }
    });
    assert.equal(response.statusCode, 200);
    const preview = await app.inject({
      method: "GET", url, headers: { authorization: "Bearer " + token, "x-prismo-peer": TEST_PEER }
    });
    assert.equal(preview.statusCode, 200);
    assert.match(String(preview.headers["content-type"]), /image\/png/);
    assert.deepEqual(preview.rawPayload, image);
  } finally {
    await app.close();
    if (original === undefined) delete process.env.PRISMO_CONFIG_DIR;
    else process.env.PRISMO_CONFIG_DIR = original;
    await rm(base, { recursive: true, force: true });
  }
});

test("image previews preserve binary bytes across worktree, index and commits", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-image-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const image = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
    await writeFile(join(path, "sample.png"), image);
    const repo = { id: "image", name: "repo", path };
    const working = await readImagePreview(repo, "sample.png");
    assert.equal(working?.contentType, "image/png");
    assert.deepEqual(working?.bytes, image);
    await git(path, ["add", "sample.png"]);
    assert.deepEqual((await readImagePreview(repo, "sample.png", "index"))?.bytes, image);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Add image"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    assert.deepEqual((await readImagePreview(repo, "sample.png", "worktree", stdout.trim()))?.bytes,
      image);
    await writeFile(join(path, "sample.png"), "not an image");
    await assert.rejects(readImagePreview(repo, "sample.png"), { statusCode: 415 });
    await assert.rejects(readImagePreview(repo, ".env"), { statusCode: 403 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("commit changes distinguish deleted images from retained images", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-deleted-image-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const image = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
    await writeFile(join(path, "removed.png"), image);
    await writeFile(join(path, "retained.png"), image);
    await git(path, ["add", "."]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Images"]);
    await unlink(join(path, "removed.png"));
    const revised = Buffer.concat([image, Buffer.from([1])]);
    await writeFile(join(path, "retained.png"), revised);
    await git(path, ["add", "-A"]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Delete one image"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    const hash = stdout.trim();
    const repo = { id: "deleted-image", name: "repo", path };
    const changes = await getCommitFileChanges(repo, hash);
    assert.deepEqual(
      Object.fromEntries(changes.map(change => [change.path, change.deleted])),
      { "removed.png": true, "retained.png": false }
    );
    assert.deepEqual(changes.map(change => change.path), ["removed.png", "retained.png"]);
    assert.equal(await readImagePreview(repo, "removed.png", "worktree", hash), null);
    assert.deepEqual((await readImagePreview(repo, "retained.png", "worktree", hash))?.bytes, revised);
    assert.match(await getCommitDiff(repo, hash, "removed.png"), /deleted file mode/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("isolated Git respects host autocrlf when showing unchanged diff context", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-eol-"));
  const path = join(base, "repo");
  const home = join(base, "home");
  try {
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), "[core]\n\tautocrlf = true\n");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    const gitHost = (args: string[]) => exec("git", ["-C", path, ...args],
      { env, timeout: 10000 });
    await exec("git", ["init", "-b", "main", path], { cwd: base, env });
    const original = Array.from({ length: 24 }, (_, index) => "unchanged-" + index);
    await writeFile(join(path, "example.cs"), original.join("\n") + "\n");
    await gitHost(["add", "example.cs"]);
    await gitHost(["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Initial"]);
    const edited = original.slice();
    edited[17] = "updated";
    await writeFile(join(path, "example.cs"), edited.join("\r\n") + "\r\n");
    const moduleURL = new URL("../git.js", import.meta.url).href;
    const code = "import { getDiff } from " + JSON.stringify(moduleURL) + "; "
      + "const repo = { id: 'eol', name: 'repo', path: process.argv[1] }; "
      + "const diff = await getDiff(repo, 'example.cs', 'unstaged', true); "
      + "const lines = diff.slice(diff.indexOf('@@')).split('\\n'); "
      + "const added = lines.filter(line => line.startsWith('+')).length; "
      + "const deleted = lines.filter(line => line.startsWith('-')).length; "
      + "const context = lines.filter(line => line.startsWith(' ')).length; "
      + "if (added !== 1 || deleted !== 1 || context !== 23) "
      + "throw Error(JSON.stringify({ added, deleted, context }));";
    await exec(process.execPath, ["--input-type=module", "--eval", code, path],
      { env, timeout: 15000 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("full diff context includes unchanged lines for files and commits", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-full-diff-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const initial = Array.from({ length: 20 }, (_, index) => "unchanged-" + (index + 1));
    await writeFile(join(path, "example.cs"), initial.join("\n") + "\n");
    await git(path, ["add", "example.cs"]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "First"]);
    const changed = initial.slice();
    changed[15] = "updated";
    await writeFile(join(path, "example.cs"), changed.join("\n") + "\n");
    const repo = { id: "full", name: "repo", path };
    assert.doesNotMatch(await getDiff(repo, "example.cs", "unstaged"), /unchanged-1\n/);
    assert.match(await getDiff(repo, "example.cs", "unstaged", true), /unchanged-1\n/);
    await git(path, ["add", "example.cs"]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", "Second"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    assert.doesNotMatch(await getCommitDiff(repo, stdout.trim(), "example.cs"), /unchanged-1\n/);
    assert.match(await getCommitDiff(repo, stdout.trim(), "example.cs", true), /unchanged-1\n/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("concurrent processes preserve every repository registration", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-config-"));
  const settings = join(base, "settings");
  const original = process.env.PRISMO_CONFIG_DIR;
  try {
    await mkdir(join(settings, "Prismo"), { recursive: true });
    const locations = Array.from({ length: 4 }, (_, i) => join(base, "repo-" + i));
    await Promise.all(locations.map(location => git(base, ["init", "-b", "main", location])));
    const moduleURL = new URL("../config.js", import.meta.url).href;
    const code = "import { addRepository } from " + JSON.stringify(moduleURL)
      + "; await addRepository(process.argv[1]);";
    await Promise.all(locations.map(location => exec(process.execPath,
      ["--input-type=module", "--eval", code, location],
      { env: { ...process.env, PRISMO_CONFIG_DIR: settings }, timeout: 15000 })));
    process.env.PRISMO_CONFIG_DIR = settings;
    const found = await listRepositories();
    assert.equal(found.length, locations.length);
    assert.equal(new Set(found.map(item => item.path)).size, locations.length);
  } finally {
    if (original === undefined) delete process.env.PRISMO_CONFIG_DIR;
    else process.env.PRISMO_CONFIG_DIR = original;
    await rm(base, { recursive: true, force: true });
  }
});

test("merge commit changes are compared against the first parent", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-history-"));
  const path = join(base, "repo");
  const commit = async (filename: string) => {
    await writeFile(join(path, filename), filename + "\n");
    await git(path, ["add", filename]);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "-m", filename]);
  };
  try {
    await git(base, ["init", "-b", "main", path]);
    await commit("base.txt");
    await git(path, ["checkout", "-b", "feature"]);
    await commit("feature.txt");
    await git(path, ["checkout", "main"]);
    await commit("main.txt");
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "merge", "--no-ff", "feature", "-m", "Merge feature"]);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
    const repo = { id: "history", name: "repo", path };
    assert.deepEqual((await getCommitFileChanges(repo, stdout.trim())).map(change => change.path),
      ["feature.txt"]);
    assert.match(await getCommitDiff(repo, stdout.trim(), "feature.txt"), /\+feature.txt/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("commit history preserves separator characters in user-controlled metadata", async () => {
  const base = await mkdtemp(join(tempRoot, "prismo-commit-meta-"));
  const path = join(base, "repo");
  try {
    await git(base, ["init", "-b", "main", path]);
    const subject = "Subject\x1fpart\x1eend";
    const author = "A\x1fB\x1eC";
    await git(path, ["-c", "user.name=" + author, "-c", "user.email=test@example.org",
      "commit", "--allow-empty", "-m", subject]);
    const repo = { id: "metadata", name: "repo", path };
    const result = await getCommits(repo);
    assert.equal(result.commits.length, 1);
    assert.equal(result.commits[0]?.subject, subject);
    assert.equal(result.commits[0]?.author, author);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("commit history pages remain stable when new commits arrive", async () => {
  const root = await mkdtemp(join(tempRoot, "prismo-commits-"));
  const path = join(root, "repo");
  try {
    await git(root, ["init", "-b", "main", path]);
    for (let i = 0; i < 34; i++) {
      await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
        "commit", "--allow-empty", "-m", "Commit " + i]);
    }
    const repo = { id: "commits", name: "repo", path };
    const first = await getCommits(repo);
    assert.equal(first.commits.length, 30);
    assert.ok(first.nextCursor);
    await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "commit", "--allow-empty", "-m", "New after pagination"]);
    const next = await getCommits(repo, first.nextCursor!);
    assert.equal(next.commits.length, 4);
    assert.equal(next.nextCursor, null);
    const hashes = [...first.commits, ...next.commits].map(item => item.hash);
    assert.equal(new Set(hashes).size, 34);
    const refreshed = await getCommits(repo);
    assert.equal(refreshed.commits[0]?.subject, "New after pagination");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

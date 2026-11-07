import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { execGit, getStatus, readIndexFile, validatePath } from "../git.js";

const exec = promisify(execFile);

test("Git commands reject replaced repository root", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-git-root-"));
  const registered = join(base, "registered");
  const moved = join(base, "old");
  const outside = join(base, "outside");
  try {
    await mkdir(registered);
    await mkdir(outside);
    await exec("git", ["init", "-b", "main"], { cwd: registered });
    await exec("git", ["init", "-b", "main"], { cwd: outside });
    await rename(registered, moved);
    await symlink(outside, registered, process.platform === "win32" ? "junction" : "dir");
    const repository = { id: "root", name: "root", path: registered };
    await assert.rejects(getStatus(repository), { statusCode: 403 });
    await assert.rejects(readIndexFile(repository, "private.txt"), { statusCode: 403 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("SSH private key backup names remain inaccessible but public keys do not", () => {
  for (const name of ["id_ed25519.bak", "id_rsa.old", "id_ecdsa_sk.backup", "id_ed25519~"]) {
    assert.throws(() => validatePath(name), { statusCode: 403 });
  }
  assert.equal(validatePath("id_ed25519.pub"), "id_ed25519.pub");
});

test("read-only Git diffs ignore executable repository clean filters", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "prismo-filter-"));
  const marker = join(root, "filter-executed.txt");
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await writeFile(join(root, ".gitattributes"), "tracked.txt filter=probe\n");
    await writeFile(join(root, "tracked.txt"), "before\n");
    await exec("git", ["add", ".gitattributes", "tracked.txt"], { cwd: root });
    await exec("git", ["-c", "user.name=Prismo", "-c", "user.email=prismo@example.invalid",
      "commit", "-m", "baseline"], { cwd: root });
    await exec("git", ["config", "filter.probe.clean",
      `echo ran > "${marker.replaceAll("\\", "/")}"; cat`], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "after\n");
    await exec("git", ["diff", "--", "tracked.txt"], { cwd: root });
    assert.equal((await stat(marker)).isFile(), true);
    await unlink(marker);
    await exec("git", ["config", "filter.probe.process",
      `echo process > "${marker.replaceAll("\\", "/")}"; cat`], { cwd: root });
    const output = await execGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--", "tracked.txt"], root);
    assert.match(output, /tracked\.txt/);
    const status = await getStatus({ id: "filter", name: "filter", path: root });
    assert.ok(status.changes.some(change => change.path === "tracked.txt"));
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

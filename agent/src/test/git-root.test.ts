import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { getStatus, readIndexFile } from "../git.js";

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

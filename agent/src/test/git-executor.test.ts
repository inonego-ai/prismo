import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execGit } from "../git.js";
import { GitExecutor } from "../git-executor.js";

test("cancelled Git requests leave the pending queue without taking a slot", async () => {
  const owner = new GitExecutor();
  const releases: Array<() => void> = [];
  let started = 0;
  let filled!: () => void;
  const allStarted = new Promise<void>(resolve => { filled = resolve; });
  const busy = Array.from({ length: 4 }, () => owner.execute(async () => {
    if (++started === 4) filled();
    await new Promise<void>(resolve => releases.push(resolve));
  }));
  await allStarted;
  const aborted = new AbortController();
  const discarded = owner.execute(async () => {
    assert.fail("An aborted queued operation must not run");
  }, aborted.signal);
  aborted.abort();
  await assert.rejects(discarded, { name: "AbortError" });
  let nextStarted = false;
  const next = owner.execute(async () => {
    nextStarted = true;
    return "done";
  });
  assert.equal(nextStarted, false);
  releases.shift()!();
  assert.equal(await next, "done");
  releases.forEach(release => release());
  await Promise.all(busy);
  await owner.close();
});

test("request context cancels real Git commands waiting behind other Git work", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-git-cancel-"));
  const owner = new GitExecutor();
  const releases: Array<() => void> = [];
  let ready!: () => void;
  const filled = new Promise<void>(resolve => { ready = resolve; });
  let started = 0;
  try {
    execFileSync("git", ["init", "--quiet", folder]);
    // Hosted Windows runners may expose a temporary path through a junction.
    // API callers always use the canonical path returned by registration.
    const registeredRoot = await realpath(folder);
    const busy = Array.from({ length: 4 }, () => owner.execute(async () => {
      if (++started === 4) ready();
      await new Promise<void>(resolve => releases.push(resolve));
    }));
    await filled;
    const abort = new AbortController();
    const pending = owner.runRequest(abort.signal,
      () => execGit(registeredRoot, ["rev-parse", "--git-dir"], registeredRoot));
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    releases.forEach(release => release());
    await Promise.all(busy);
    assert.equal((await owner.runRequest(new AbortController().signal,
      () => execGit(registeredRoot, ["rev-parse", "--git-dir"], registeredRoot))).trim(), ".git");
  } finally {
    releases.forEach(release => release());
    await owner.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("closing an owner aborts its running child without affecting another owner", async () => {
  const first = new GitExecutor();
  const second = new GitExecutor();
  let spawned!: () => void;
  const running = new Promise<void>(resolve => { spawned = resolve; });
  const work = first.execute(signal => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", "setTimeout(() => {}, 30000)"],
      { signal, windowsHide: true }, error => {
        if (error) reject(error);
        else resolve();
      });
    child.once("spawn", spawned);
  }));
  await running;
  await first.close();
  await assert.rejects(work, { code: "ABORT_ERR" });
  assert.equal(await second.execute(async () => "alive"), "alive");
  await second.close();
});

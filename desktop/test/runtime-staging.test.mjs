import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createStagingDirectory, removeStagingDirectory, replaceRuntimeDirectory, stageRuntime
} from "../runtime-staging.mjs";

test("refuses a junction runtime parent without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "prismo-runtime-"));
  const external = join(root, "external");
  const runtimeParent = join(root, ".runtime");
  const protectedFile = join(external, "agent", "keep.txt");
  mkdirSync(join(external, "agent"), { recursive: true });
  writeFileSync(protectedFile, "preserve");
  symlinkSync(external, runtimeParent, process.platform === "win32" ? "junction" : "dir");

  try {
    assert.throws(() => createStagingDirectory(runtimeParent), /linked or non-directory/);
    assert.equal(readFileSync(protectedFile, "utf8"), "preserve");
  } finally {
    unlinkSync(runtimeParent);
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the current runtime when dependency preparation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "prismo-runtime-"));
  const runtimeParent = join(root, ".runtime");
  const runtime = join(runtimeParent, "agent");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "current.txt"), "old");

  try {
    assert.throws(
      () => stageRuntime(runtime, () => { throw Error("npm ci failed"); }),
      /npm ci failed/
    );
    assert.equal(readFileSync(join(runtime, "current.txt"), "utf8"), "old");
    assert.deepEqual(readdirSync(runtimeParent), ["agent"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates staged runtime before replacing the current runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "prismo-runtime-"));
  const runtimeParent = join(root, ".runtime");
  const runtime = join(runtimeParent, "agent");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "current.txt"), "old");
  const staging = createStagingDirectory(runtimeParent);

  try {
    writeFileSync(join(staging, "package.json"), "{}");
    assert.throws(
      () => replaceRuntimeDirectory(join(runtimeParent, "agent-stage-missing"), runtime),
      /Staged Agent runtime is unavailable/
    );
    assert.equal(readFileSync(join(runtime, "current.txt"), "utf8"), "old");

    replaceRuntimeDirectory(staging, runtime);
    assert.equal(readFileSync(join(runtime, "package.json"), "utf8"), "{}");
    assert.equal(existsSync(join(runtime, "current.txt")), false);
  } finally {
    removeStagingDirectory(staging, runtimeParent);
    rmSync(root, { recursive: true, force: true });
  }
});

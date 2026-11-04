import {
  lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function isRealDirectory(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw Error("Refusing linked or non-directory runtime path: " + path);
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertRuntimeParent(parent) {
  if (!isRealDirectory(parent)) mkdirSync(parent);
  if (!isRealDirectory(parent)) throw Error("Runtime staging directory is unavailable.");
}

function assertManagedChild(path, parent, prefix) {
  const absoluteParent = resolve(parent);
  const absolutePath = resolve(path);
  if (dirname(absolutePath) !== absoluteParent
    || !absolutePath.slice(absoluteParent.length + 1).startsWith(prefix)) {
    throw Error("Refusing unexpected runtime path: " + path);
  }
}

export function createStagingDirectory(parent) {
  const absoluteParent = resolve(parent);
  assertRuntimeParent(absoluteParent);
  const staging = mkdtempSync(join(absoluteParent, "agent-stage-"));
  assertManagedChild(staging, absoluteParent, "agent-stage-");
  isRealDirectory(staging);
  return staging;
}

export function removeStagingDirectory(staging, parent) {
  const absoluteParent = resolve(parent);
  assertRuntimeParent(absoluteParent);
  assertManagedChild(staging, absoluteParent, "agent-stage-");
  if (!isRealDirectory(staging)) return;
  rmSync(staging, { recursive: true, force: false });
}

export function replaceRuntimeDirectory(staging, runtime) {
  const absoluteRuntime = resolve(runtime);
  const parent = dirname(absoluteRuntime);
  assertRuntimeParent(parent);
  assertManagedChild(staging, parent, "agent-stage-");
  if (!isRealDirectory(staging)) throw Error("Staged Agent runtime is unavailable.");

  let backup = null;
  if (isRealDirectory(absoluteRuntime)) {
    backup = join(parent, "agent-backup-" + randomUUID());
    renameSync(absoluteRuntime, backup);
  }

  try {
    renameSync(staging, absoluteRuntime);
  } catch (error) {
    if (backup) renameSync(backup, absoluteRuntime);
    throw error;
  }

  if (backup) rmSync(backup, { recursive: true, force: false });
}

export function stageRuntime(runtime, prepare) {
  const absoluteRuntime = resolve(runtime);
  const parent = dirname(absoluteRuntime);
  const staging = createStagingDirectory(parent);
  try {
    prepare(staging);
    replaceRuntimeDirectory(staging, absoluteRuntime);
  } finally {
    removeStagingDirectory(staging, parent);
  }
}

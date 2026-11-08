import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const session = join(tmpdir(), "prismo-emulator-pair-session");
const sessionFile = join(session, "session.json");
const readyFile = join(session, "ready.json");
const ownerFile = ".prismo-e2e-owner";

const exists = path => access(path).then(() => true, () => false);
const running = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};
async function readSession() {
  try { return JSON.parse(await readFile(sessionFile, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function validate(state) {
  if (!state || typeof state.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(state.id) ||
      typeof state.fixture !== "string" ||
      resolve(dirname(state.fixture)) !== resolve(tmpdir()) ||
      !/^prismo-emulator-e2e-[\w-]+$/.test(basename(state.fixture))) {
    throw Error("Invalid isolated test session; refusing to remove files");
  }
}
async function cleanup(state) {
  validate(state);
  if (await exists(state.fixture)) {
    const owner = await readFile(join(state.fixture, ownerFile), "utf8");
    if (owner !== state.id) throw Error("Test fixture owner mismatch");
    await rm(state.fixture, { recursive: true, force: true });
  }
  await rm(readyFile, { force: true });
  await rm(sessionFile, { force: true });
}
function saveSession(state) {
  const temporary = sessionFile + "." + state.id + ".tmp";
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, sessionFile);
}
async function stop() {
  const state = await readSession();
  if (!state) throw Error("No isolated test host is registered");
  validate(state);
  if (!running(state.childPID)) {
    if (running(state.runnerPID)) throw Error("Test host is still initializing");
    await cleanup(state);
    console.log("Removed a stopped test session.");
    return;
  }
  await writeFile(join(state.fixture, "stop"), "stop");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && await exists(sessionFile)) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (await exists(sessionFile)) throw Error("Test host did not shut down");
  console.log("Isolated test host stopped.");
}

if (process.argv.includes("--stop")) {
  await stop();
} else {
  await mkdir(session, { recursive: true });
  const previous = await readSession();
  if (previous) {
    validate(previous);
    if (running(previous.childPID) || running(previous.runnerPID)) {
      throw Error("An emulator test host is already running");
    }
    await cleanup(previous);
  } else if (await exists(readyFile)) {
    throw Error("Unowned pairing data exists; refusing to overwrite it");
  }

  const fixture = await mkdtemp(join(tmpdir(), "prismo-emulator-e2e-"));
  const state = { id: randomUUID(), fixture, runnerPID: process.pid, childPID: null };
  try {
    await writeFile(join(fixture, ownerFile), state.id, { mode: 0o600 });
    const handle = openSync(sessionFile, "wx", 0o600);
    try { writeFileSync(handle, JSON.stringify(state)); }
    finally { closeSync(handle); }
  } catch (error) {
    await rm(fixture, { recursive: true, force: true });
    throw error;
  }

  let child;
  try {
    child = spawn(electron, ["test/emulator-pair-host.mjs"], {
      cwd: desktop,
      env: {
        ...process.env,
        PRISMO_EMULATOR_TEST_READY: readyFile,
        PRISMO_EMULATOR_TEST_FIXTURE: fixture
      },
      stdio: "inherit",
      windowsHide: true
    });
    state.childPID = child.pid ?? null;
    saveSession(state);
  } catch (error) {
    await cleanup(state);
    throw error;
  }

  let closing = false;
  const requestStop = async () => {
    if (closing) return;
    closing = true;
    try { await writeFile(join(fixture, "stop"), "stop"); }
    catch (error) {
      console.error("Could not request test shutdown:", error.message);
      child.kill();
    }
  };
  process.on("SIGINT", () => { void requestStop(); });
  process.on("SIGTERM", () => { void requestStop(); });
  child.once("error", error => {
    console.error("Test host startup failed:", error);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    void cleanup(state).catch(error => {
      console.error("Test session cleanup failed:", error);
      process.exitCode = 1;
    }).finally(() => {
      if (code !== 0 || signal) process.exitCode = 1;
      console.log("Test host exited:", code, signal);
    });
  });
  console.log("Pairing data: " + readyFile);
  console.log("To stop: node test/run-emulator-pair-host.mjs --stop");
}

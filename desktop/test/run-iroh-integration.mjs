import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "prismo-iroh-test-"));
const resultFile = join(directory, "result.log");
const controller = new AbortController();
const watchdog = setTimeout(() => {
  controller.abort(new Error("Iroh integration timed out"));
}, 90_000);

try {
  const child = spawn(electron, ["test/iroh-integration.mjs"], {
    cwd: desktop,
    env: { ...process.env, PRISMO_INTEGRATION_RESULT: resultFile },
    stdio: "inherit",
    windowsHide: true,
    signal: controller.signal
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error("Electron exited from signal " + signal));
      else resolve(code);
    });
  });
  const result = await readFile(resultFile, "utf8")
    .catch(() => "(no integration result)");
  if (exitCode !== 0 || !result.startsWith("PASS:")) {
    throw new Error("Iroh integration exited " + exitCode + ": " + result.trim());
  }
  console.log(result.trim());
} finally {
  clearTimeout(watchdog);
  await rm(directory, { recursive: true, force: true });
}

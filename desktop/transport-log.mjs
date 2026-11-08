import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

const MAX_BYTES = 512 * 1024;
const KNOWN_ERRORS = new Map([
  ["Connection timed out", "ConnectionTimeout"],
  ["Response transfer stalled", "ResponseStall"],
  ["Response transfer cancelled", "ResponseCancelled"],
  ["Invalid request", "InvalidRequest"],
  ["Invalid response size", "InvalidResponseSize"],
  ["Incomplete response", "IncompleteResponse"],
  ["Response too large", "ResponseTooLarge"]
]);
let writes = Promise.resolve();

// Keep only fixed event labels and error types: never store peer IDs, tokens or paths.
function record(stage, kind = "") {
  const line = new Date().toISOString() + " " + stage + (kind ? " " + kind : "") + "\n";
  const directory = app.getPath("userData");
  writes = writes.then(async () => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, "transport.log");
    const size = (await stat(file).catch(() => ({ size: 0 }))).size;
    if (size >= MAX_BYTES) {
      await rm(file + ".old", { force: true });
      await rename(file, file + ".old");
    }
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  }).catch(error => {
    console.warn("Prismo transport log unavailable:", error?.name ?? "Error");
  });
}

export function flushTransportLog() {
  return writes;
}

export function logTransportEvent(stage) {
  record(stage);
}

export function logTransportFailure(stage, error) {
  const candidate = error instanceof Error ? error.name : typeof error;
  const type = /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(candidate) ? candidate : "Error";
  const kind = KNOWN_ERRORS.get(error?.message) ?? type;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? " " + error.code : "";
  console.warn("Prismo Iroh", stage, kind + code);
  record(stage, kind + code);
}

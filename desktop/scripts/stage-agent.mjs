import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageRuntime } from "../runtime-staging.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = resolve(desktop, "..", "agent");
const runtimeParent = join(desktop, ".runtime");
const runtime = join(runtimeParent, "agent");

function npm(cwd, args) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? "cmd.exe" : "npm",
    windows ? ["/d", "/c", "npm.cmd", ...args] : args,
    { cwd, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error("Agent build preparation failed");
}

npm(agent, ["run", "build"]);
stageRuntime(runtime, staging => {
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(agent, name), join(staging, name));
  }
  npm(staging, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"]);
});

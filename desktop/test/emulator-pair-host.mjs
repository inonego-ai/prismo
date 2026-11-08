// Isolated, local-only fixture for manual Android emulator UI E2E testing.
import { app } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PrismoHost } from "../iroh.mjs";

const readyPath = process.env.PRISMO_EMULATOR_TEST_READY;
const fixture = process.env.PRISMO_EMULATOR_TEST_FIXTURE;
if (!readyPath || !fixture) throw Error("Emulator test session is required");
const userData = join(fixture, "electron");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
process.env.PRISMO_CONFIG_DIR = join(fixture, "config");
let host, api;
let stopping = false;
const requests = new Map();
async function publish(pairing, repository) {
  const pending = pairing.issue();
  const url = "prismo://pair?pc=" + host.id + "&code="
    + pending.secret + "&v=1";
  const data = {
    url, fixture, repository: repository.id,
    stopPath: join(fixture, "stop"),
    expiresAt: pending.expiresAt
  };
  await writeFile(readyPath, JSON.stringify(data), { mode: 0o600 });
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    try {
      if (host) await host.stop();
    } finally {
      if (api) await api.close();
    }
  } finally {
    await rm(readyPath, { force: true });
    // The runner validates ownership and removes the isolated fixture.
    app.quit();
  }
}
void app.whenReady().then(async () => {
  const { createApp } = await import("../../agent/dist/api.js");
  const { PairingStore } = await import("../../agent/dist/pairing.js");
  const { UpdateStore } = await import("../../agent/dist/updates.js");
  const { addRepository } = await import("../../agent/dist/config.js");
  const source = join(fixture, "e2e-repository");
  await mkdir(join(source, "src"), { recursive: true });
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "config", "core.autocrlf", "false"]);
  await writeFile(join(source, "README.md"), "Emulator integration fixture\n");
  await writeFile(join(source, "src", "sample.txt"), "first line\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "-c", "user.name=Prismo Test",
    "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial"]);
  await writeFile(join(source, "src", "sample.txt"), "first line\nsecond line\n");
  execFileSync("git", ["-C", source, "add", "src/sample.txt"]);
  execFileSync("git", ["-C", source, "-c", "user.name=Prismo Test",
    "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Add second line"]);
  await writeFile(join(source, "src", "sample.txt"),
    "first line\nsecond line\nthird line (unstaged)\n");
  await writeFile(join(source, "untracked.txt"), "untracked sample\n");
  const repository = await addRepository(source);
  const pairing = new PairingStore(join(fixture, "paired.json"));
  api = createApp(pairing, new UpdateStore(join(fixture, "updates.json")),
    async (_name, signal) => !signal.aborted);
  api.addHook("onRequest", async request => {
    const route = request.routeOptions.url ?? "unknown";
    requests.set(route, (requests.get(route) ?? 0) + 1);
  });
  await api.ready();
  host = new PrismoHost(api, peerID => pairing.hasPeer(peerID));
  await host.start();
  await publish(pairing, repository);
  console.log("TEST_HOST_READY");
  while (!stopping) {
    await delay(1500);
    await writeFile(join(fixture, "request-counts.json"),
      JSON.stringify(Object.fromEntries(requests)));
    if (await readFile(join(fixture, "stop")).then(() => true, () => false)) {
      await shutdown();
      break;
    }
    if (!pairing.count() && !pairing.current()) {
      await publish(pairing, repository);
    }
  }
}).catch(async error => {
  console.error("TEST_HOST_FAILED", error?.stack || String(error));
  process.exitCode = 1;
  await shutdown();
});

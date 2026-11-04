const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electron = require(path.resolve(__dirname, "../../desktop/node_modules/electron"));
const entry = path.join(__dirname, "layout-probe.cjs");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [entry], {
  encoding: "utf8", timeout: 60_000, env, windowsHide: true
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

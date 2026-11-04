import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { checkLatestGitHubRelease, compareReleaseVersions, createUpdateCheckGate } from "../update-check.mjs";

test("keeps an updater check active through available and downloaded dialogs", async () => {
  const gate = createUpdateCheckGate();
  const updater = new EventEmitter();
  let checks = 0;
  let closeAvailableDialog;
  let closeDownloadedDialog;

  updater.checkForUpdates = async () => {
    checks++;
    if (checks === 1) updater.emit("update-available");
    return "available";
  };
  updater.on("update-available", () => {
    gate.track((async () => {
      await new Promise(resolve => { closeAvailableDialog = resolve; });
      updater.emit("update-downloaded");
    })());
  });
  updater.on("update-downloaded", () => {
    gate.track(new Promise(resolve => { closeDownloadedDialog = resolve; }));
  });

  const first = gate.run(() => updater.checkForUpdates());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1);

  const duplicate = gate.run(() => updater.checkForUpdates());
  assert.equal(duplicate, first);
  closeAvailableDialog();
  await new Promise(resolve => setImmediate(resolve));

  const whileDownloadedDialogOpen = gate.run(() => updater.checkForUpdates());
  assert.equal(whileDownloadedDialogOpen, first);
  assert.equal(checks, 1);

  closeDownloadedDialog();
  assert.equal(await first, "available");
  assert.equal(await gate.run(() => updater.checkForUpdates()), "available");
  assert.equal(checks, 2);
});

test("releases the check gate after a failed check", async () => {
  const gate = createUpdateCheckGate();
  await assert.rejects(gate.run(async () => { throw Error("offline"); }), /offline/);
  assert.equal(await gate.run(async () => "retried"), "retried");
});

const source = { owner: "inonego-ai", repo: "prismo" };

test("compares release versions numerically", () => {
  assert.equal(compareReleaseVersions("0.1.0", "v0.1.1"), 1);
  assert.equal(compareReleaseVersions("0.9.0", "v0.10.0"), 1);
  assert.equal(compareReleaseVersions("0.1.0", "v0.1.0"), 0);
  assert.equal(compareReleaseVersions("0.2.0", "v0.1.0"), -1);
  assert.equal(compareReleaseVersions("invalid", "v0.1.0"), null);
});

test("reports missing public releases instead of opening a browser", async () => {
  const calls = [];
  const result = await checkLatestGitHubRelease(source, "0.1.0", async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 404 });
  });
  assert.equal(result.kind, "unpublished");
  assert.equal(calls[0].url, "https://api.github.com/repos/inonego-ai/prismo/releases/latest");
});

test("reports available and current releases", async () => {
  const fetcher = async () => new Response(
    JSON.stringify({ draft: false, prerelease: false, tag_name: "v0.2.0" }),
    { status: 200 }
  );
  assert.equal((await checkLatestGitHubRelease(source, "0.1.0", fetcher)).kind, "available");
  assert.equal((await checkLatestGitHubRelease(source, "0.2.0", fetcher)).kind, "current");
  assert.equal((await checkLatestGitHubRelease(source, "0.3.0", fetcher)).kind, "current");
});

test("rejects unsupported release metadata and propagates fetch errors", async () => {
  const invalid = async () => new Response(
    JSON.stringify({ draft: false, prerelease: false, tag_name: "unsafe" }), { status: 200 }
  );
  assert.equal((await checkLatestGitHubRelease(source, "0.1.0", invalid)).kind, "error");
  await assert.rejects(
    checkLatestGitHubRelease(source, "0.1.0", async () => new Response(null, { status: 403 })),
    /403/
  );
});

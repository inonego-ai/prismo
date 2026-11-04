import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdateCheckGate } from "../update-check.mjs";

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

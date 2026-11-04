import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PairingStore } from "../pairing.js";
import { UpdateStore } from "../updates.js";
import { createApp } from "../api.js";

test("pairing code is consumed before a failed credential write and cannot be replayed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-pairing-consume-"));
  const parent = join(folder, "devices");
  const location = join(parent, "paired.json");
  const store = new PairingStore(location);
  await store.initialize();
  const code = store.issue().secret;
  const app = createApp(store, new UpdateStore(), async () => true);
  try {
    await writeFile(parent, "block directory creation");
    const failed = await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code } });
    assert.equal(failed.statusCode, 500);
    assert.equal(store.current(), null);
    await unlink(parent);
    const replay = await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code } });
    assert.equal(replay.statusCode, 401);
    assert.equal(store.count(), 0);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("pairing codes are temporary, single-use, and independent from device credentials", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-pairing-"));
  const location = join(folder, "devices.json");
  try {
    const store = new PairingStore(location);
    await store.initialize();
    store.issue(1000);
    assert.equal(store.current(121000), null);
    const pending = store.issue();
    assert.match(pending.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await store.accept("incorrect"), null);
    const deviceToken = await store.accept(pending.secret);
    assert.ok(deviceToken);
    assert.equal(store.current(), null);
    assert.equal(await store.accept(pending.secret), null);
    assert.equal(store.authorized("Bearer " + deviceToken), true);
    assert.equal(store.authorized("Bearer " + pending.secret), false);

    const restarted = new PairingStore(location);
    await restarted.initialize();
    assert.equal(restarted.count(), 1);
    assert.equal(restarted.authorized("Bearer " + deviceToken), true);
    await restarted.revokeAll();
    assert.equal(restarted.authorized("Bearer " + deviceToken), false);
    const concurrent = restarted.issue().secret;
    const enrollment = restarted.accept(concurrent);
    const revocation = restarted.revokeAll();
    const enrolled = await enrollment;
    await revocation;
    if (enrolled) assert.equal(restarted.authorized("Bearer " + enrolled), false);
    const persisted = new PairingStore(location);
    await persisted.initialize();
    assert.equal(persisted.count(), 0);
    const cancelled = restarted.issue().secret;
    const removal = restarted.revokeAll();
    assert.equal(await restarted.accept(cancelled), null);
    await removal;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

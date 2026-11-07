import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PairingStore, deviceName } from "../pairing.js";
import { UpdateStore } from "../updates.js";
import { createApp } from "../api.js";

const TEST_PEER = "a".repeat(64);
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "C".repeat(43);

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
      payload: { code, token: TOKEN_A }, headers: { "x-prismo-peer": TEST_PEER } });
    assert.equal(failed.statusCode, 500);
    assert.equal(store.current(), null);
    await unlink(parent);
    const replay = await app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: TOKEN_A }, headers: { "x-prismo-peer": TEST_PEER } });
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
    assert.equal(store.hasPeer(TEST_PEER), false);
    store.issue(1000);
    assert.equal(store.current(121000), null);
    const pending = store.issue();
    assert.match(pending.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(deviceName("A".repeat(39) + "🙂"), "A".repeat(39));
    assert.equal(deviceName("Android 🙂"), "Android 🙂");
    assert.equal(await store.accept("incorrect", "Android", TEST_PEER, TOKEN_A), false);
    assert.equal(await store.accept(pending.secret, "Android"), false);
    assert.equal(await store.accept(pending.secret, "Android", "invalid", TOKEN_A), false);
    const deviceToken = TOKEN_A;
    assert.equal(await store.accept(pending.secret, "Android", TEST_PEER, deviceToken), true);
    assert.equal(store.current(), null);
    assert.equal(await store.accept(pending.secret, "Android", TEST_PEER, deviceToken), true);
    assert.equal(await store.accept(pending.secret, "Android", TEST_PEER, TOKEN_C), false);
    assert.equal(store.authorized("Bearer " + deviceToken, TEST_PEER), true);
    assert.equal(store.hasPeer(TEST_PEER), true);
    assert.equal(store.hasPeer("b".repeat(64)), false);
    assert.equal(store.authorized("Bearer " + deviceToken, "b".repeat(64)), false);
    assert.equal(store.authorized("Bearer " + deviceToken), false);
    assert.match(store.list()[0]!.id, /^[a-f0-9-]{36}$/);
    assert.equal(store.list()[0]!.name, "Android");
    assert.equal(store.list()[0]!.online, false);
    assert.equal(store.list(new Set([TEST_PEER]))[0]!.online, true);
    assert.equal(store.list(new Set(["b".repeat(64)]))[0]!.online, false);
    assert.equal(store.authorized("Bearer " + pending.secret, TEST_PEER), false);

    const restarted = new PairingStore(location);
    await restarted.initialize();
    assert.equal(restarted.count(), 1);
    assert.equal(restarted.authorized("Bearer " + deviceToken, TEST_PEER), true);
    await restarted.revoke(restarted.list()[0]!.id);
    assert.equal(restarted.hasPeer(TEST_PEER), false);
    assert.equal(restarted.authorized("Bearer " + deviceToken, TEST_PEER), false);
    const persisted = new PairingStore(location);
    await persisted.initialize();
    assert.equal(persisted.count(), 0);
    const cancelled = restarted.issue().secret;
    restarted.cancel();
    assert.equal(await restarted.accept(cancelled, "Android", TEST_PEER, TOKEN_A), false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("cancelled pairing approval cannot persist a credential", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-pairing-abort-"));
  const store = new PairingStore(join(folder, "paired.json"));
  await store.initialize();
  const code = store.issue().secret;
  const controller = new AbortController();
  const requestID = "a13c4d5e-6789-4012-8abc-2d3e4f506172";
  let notifyStart!: () => void;
  let release!: (accepted: boolean) => void;
  let approvalSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  const app = createApp(store, new UpdateStore(), (_name, signal) => {
    approvalSignal = signal;
    notifyStart();
    return new Promise<boolean>(resolve => {
      release = resolve;
      signal.addEventListener("abort", () => resolve(false), { once: true });
    });
  });
  try {
    const reply = app.inject({ method: "POST", url: "/api/v1/pair",
      payload: { code, token: TOKEN_A },
      headers: { "x-prismo-peer": TEST_PEER, "x-prismo-request-id": requestID },
      signal: controller.signal });
    await started;
    controller.abort();
    app.cancelRequest(requestID);
    await new Promise(resolve => setTimeout(resolve, 60));
    const aborted = approvalSignal?.aborted;
    release(false);
    await reply.catch(() => {});
    assert.equal(aborted, true, "The approval dialog must see transport cancellation");
    assert.equal(store.count(), 0);
    assert.ok(store.current(), "An aborted approval cannot consume the pairing code");
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("aborted credential acceptance leaves the pending approval intact", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-pairing-aborted-save-"));
  const store = new PairingStore(join(folder, "paired.json"));
  try {
    await store.initialize();
    const code = store.issue().secret;
    const abort = new AbortController();
    abort.abort();
    assert.equal(await store.accept(code, "Cancelled phone", TEST_PEER, TOKEN_A,
      abort.signal), false);
    assert.equal(store.count(), 0);
    assert.ok(store.current(), "A cancelled transaction cannot consume the QR code");
    assert.equal(await store.accept(code, "Phone A", TEST_PEER, TOKEN_A), true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("transport cancellation aborts downloads and releases the download slot", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-download-abort-"));
  const store = new PairingStore(join(folder, "paired.json"));
  await store.initialize();
  const code = store.issue().secret;
  assert.equal(await store.accept(code, "Phone A", TEST_PEER, TOKEN_A), true);
  const updates = new UpdateStore(join(folder, "no-release-config.json"));
  let started!: () => void;
  let aborted = false;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  updates.download = async signal => {
    started();
    return await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(Error("Aborted by transport"));
      }, { once: true });
    });
  };
  const app = createApp(store, updates, async () => true);
  const requestID = "b13c4d5e-6789-4012-8abc-2d3e4f506172";
  const headers = { authorization: "Bearer " + TOKEN_A,
    "x-prismo-peer": TEST_PEER, "x-prismo-request-id": requestID };
  try {
    const pending = app.inject({ method: "GET",
      url: "/api/v1/app/update/download", headers });
    await requestStarted;
    app.cancelRequest(requestID);
    await pending;
    assert.equal(aborted, true);
    updates.download = async () => null;
    const subsequent = await app.inject({ method: "GET",
      url: "/api/v1/app/update/download", headers });
    assert.equal(subsequent.statusCode, 404, "Cancellation must release the quota");
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("individual device revocation preserves unrelated Iroh peers", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prismo-iroh-devices-"));
  const store = new PairingStore(join(folder, "devices.json"));
  const peerB = "b".repeat(64);
  try {
    await store.initialize();
    const tokenA = TOKEN_A;
    const tokenB = TOKEN_B;
    assert.equal(await store.accept(store.issue().secret, "Phone A", TEST_PEER, tokenA), true);
    assert.equal(await store.accept(store.issue().secret, "Phone B", peerB, tokenB), true);
    assert.equal(store.list().length, 2);
    const first = store.list().find(device => device.name === "Phone A")!;
    await store.revoke(first.id);
    assert.equal(store.count(), 1);
    assert.equal(store.authorized("Bearer " + tokenA, TEST_PEER), false);
    assert.equal(store.authorized("Bearer " + tokenB, peerB), true);
    const renewed = TOKEN_C;
    assert.equal(await store.accept(store.issue().secret,
      "Phone B again", peerB, renewed), true);
    assert.equal(store.count(), 1);
    assert.equal(store.authorized("Bearer " + tokenB, peerB), false);
    assert.equal(store.authorized("Bearer " + renewed, peerB), true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

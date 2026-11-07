import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import { app } from "electron";
import { Endpoint, EndpointAddr, EndpointId } from "@number0/iroh";
import { PrismoHost } from "../iroh.mjs";
import { flushTransportLog } from "../transport-log.mjs";

const resultFile = process.env.PRISMO_INTEGRATION_RESULT ?? join(tmpdir(), "prismo-iroh-integration-result.log");
const dir = await mkdtemp(join(tmpdir(), "prismo-iroh-integration-"));
app.setPath("userData", join(dir, "electron"));
process.env.PRISMO_CONFIG_DIR = join(dir, "config");
let host, api;
let clientA, clientB;
const connections = [];
const alpn = [...Buffer.from("prismo/git/1")];

function requestBytes(method, path, data, token) {
  const body = data === undefined ? "" : Buffer.from(JSON.stringify(data)).toString("base64");
  return Buffer.from(JSON.stringify({
    method, path, body, authorization: token ? "Bearer " + token : ""
  }));
}

async function send(connection, method, path, data, token, binary = false) {
  const stream = await connection.openBi();
  const input = requestBytes(method, path, data, token);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(input.length);
  await stream.send.writeAll([...length]);
  await stream.send.writeAll([...input]);
  await stream.send.finish();
  const size = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
  assert.ok(size > 0 && size < 8192);
  const header = JSON.parse(Buffer.from(await stream.recv.readExact(size)).toString("utf8"));
  const payload = Buffer.from(await stream.recv.readExact(header.length));
  assert.equal((await stream.recv.read(1)).length, 0,
    "Every complete response must end with a QUIC FIN");
  return { status: header.status, data: binary ? payload : JSON.parse(payload.toString("utf8")) };
}

async function verifyKotlinClient(host) {
  if (process.env.PRISMO_NATIVE_IROH_SMOKE !== "1") return;
  const socket = host.endpoint.boundSockets()
    .find(address => address.startsWith("0.0.0.0:"));
  assert.ok(socket, "Kotlin client requires a loopback-compatible host socket");
  const port = socket.split(":").at(-1);
  const directory = join(import.meta.dirname, "../../android");
  const gradleArgs = [":app:testDebugUnitTest", "--tests",
    "dev.prismo.app.IrohNativeInteropTest", "--no-daemon", "--console=plain"];
  const windows = process.platform === "win32";
  const child = spawn(windows ? process.env.ComSpec || "cmd.exe" : "./gradlew",
    windows ? ["/d", "/c", "gradlew.bat", ...gradleArgs] : gradleArgs, {
      cwd: directory, stdio: "inherit", windowsHide: true,
      env: { ...process.env, PRISMO_NODE_HOST_ID: host.id, PRISMO_NODE_HOST_PORT: port }
    });
  const timer = setTimeout(() => child.kill(), 65_000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => signal
        ? reject(Error("Kotlin native interoperability worker terminated"))
        : resolve(code));
    });
    assert.equal(exit, 0, "Kotlin client failed to exchange repeated Iroh requests");
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= until) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function cancelStream(connection, path, token) {
  const stream = await connection.openBi();
  const input = requestBytes("GET", path, undefined, token);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(input.length);
  await stream.send.writeAll([...size]);
  await stream.send.writeAll([...input]);
  await stream.send.finish();
  const headerSize = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
  const header = JSON.parse(Buffer.from(await stream.recv.readExact(headerSize)).toString());
  assert.equal(header.status, 200);
  await stream.recv.stop(0n);
}

async function connect(client, target) {
  const address = new EndpointAddr(EndpointId.fromString(target.id), null,
    ["127.0.0.1:" + target.endpoint.boundSockets()
      .find(socket => socket.startsWith("0.0.0.0:")).split(":").at(-1)]);
  const connected = await Promise.race([
    client.connect(address, alpn),
    new Promise((_r, reject) => setTimeout(() => reject(Error("connect timeout")), 10000))
  ]);
  connections.push(connected);
  return connected;
}

async function verifyImageResponseQuota() {
  const pending = [];
  const limitedHost = new PrismoHost({
    inject: () => new Promise(resolve => pending.push(resolve))
  });
  function imageStream(path = "/api/v1/repositories/test/image?path=sample.png",
                       stalledWrite = 0, failedWrite = 0) {
    const input = requestBytes("GET", path);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(input.length);
    const written = [];
    let reads = 0;
    let resets = 0;
    let rejectBlocked;
    const stream = {
      recv: {
        async readExact() { return reads++ === 0 ? prefix : input; },
        async stop() {}
      },
      send: {
        async stopped() { return new Promise(() => {}); },
        async writeAll(data) {
          written.push(Buffer.from(data));
          if (written.length === failedWrite) throw Error("Simulated send failure");
          if (written.length === stalledWrite) {
            await new Promise((_resolve, reject) => { rejectBlocked = reject; });
          }
        },
        async finish() {},
        async reset() {
          resets++;
          rejectBlocked?.(Error("Stream reset"));
        }
      }
    };
    return { stream, written, get resets() { return resets; } };
  }
  const requests = Array.from({ length: 4 }, () =>
    limitedHost.respond(imageStream().stream, "test-peer"));
  await waitFor(() => pending.length === 4, "Image quota did not fill");
  assert.equal(limitedHost.activeImageResponses, 4);

  const excess = imageStream("/api/v1/repositories/test/%69mage?path=sample.png");
  await limitedHost.respond(excess.stream, "test-peer");
  const header = JSON.parse(excess.written[1].toString("utf8"));
  assert.equal(header.status, 429);
  assert.equal(limitedHost.activeImageResponses, 4);

  const partial = imageStream(undefined, 0, 2);
  await limitedHost.respond(partial.stream, "test-peer");
  assert.equal(partial.written.length, 2, "A failed 429 must not append a 500 frame");
  assert.equal(partial.resets, 1);

  const failedReplyHost = new PrismoHost({
    inject: async () => { throw Error("Upstream failed"); }
  });
  const failedReply = imageStream(undefined, 0, 2);
  await failedReplyHost.respond(failedReply.stream, "test-peer");
  assert.equal(failedReply.resets, 1, "A failed 500 frame must reset its stream");
  assert.equal(failedReplyHost.requests.size, 0);

  const previous = new Set(limitedHost.requests.keys());
  const cancelled = imageStream(undefined, 3);
  const cancelledRequest = limitedHost.respond(cancelled.stream, "test-peer");
  await waitFor(() => cancelled.written.length === 3, "429 did not reach body send");
  const controller = [...limitedHost.requests.keys()].find(item => !previous.has(item));
  assert.ok(controller);
  controller.abort();
  await Promise.race([cancelledRequest, new Promise((_resolve, reject) =>
    setTimeout(() => reject(Error("Cancelled 429 was not released")), 1000))]);
  assert.equal(cancelled.resets, 1);
  assert.equal(limitedHost.requests.size, 4);

  for (const resolve of pending) {
    resolve({
      statusCode: 200,
      headers: { "content-length": "0" },
      stream: () => Readable.from([])
    });
  }
  await Promise.all(requests);
  assert.equal(limitedHost.activeImageResponses, 0);
  assert.equal(limitedHost.requests.size, 0);

  const timedHost = new PrismoHost({ inject: () => new Promise(() => {}) },
    () => false, 350);
  const admitted = Array.from({ length: 4 }, () =>
    timedHost.respond(imageStream().stream, "test-peer"));
  await waitFor(() => timedHost.activeImageResponses === 4,
    "Timed image quota did not fill");
  const timedOut = imageStream(undefined, 3);
  await Promise.race([
    timedHost.respond(timedOut.stream, "test-peer"),
    new Promise((_resolve, reject) => setTimeout(() =>
      reject(Error("Stalled 429 request was not released")), 1500))
  ]);
  assert.equal(timedOut.resets, 1);
  await Promise.all(admitted);
  assert.equal(timedHost.activeImageResponses, 0);
  assert.equal(timedHost.requests.size, 0);
}

async function verifyImageStallRecovery() {
  const payload = Buffer.alloc(65536, 42);
  const api = { inject: async () => ({
    statusCode: 200,
    headers: { "content-length": String(payload.length), "content-type": "image/png" },
    stream: () => Readable.from([payload])
  }) };
  function imageStream(stall = true,
                       path = "/api/v1/repositories/test/image?path=sample.png") {
    const input = requestBytes("GET", path);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(input.length);
    let reads = 0;
    let writes = 0;
    let resets = 0;
    let rejectBlocked;
    const written = [];
    return {
      get writes() { return writes; },
      get resets() { return resets; },
      written,
      stream: {
        recv: {
          async readExact() { return reads++ === 0 ? length : input; },
          async stop() {}
        },
        send: {
          async stopped() { return new Promise(() => {}); },
          async writeAll(data) {
            writes++;
            written.push(Buffer.from(data));
            if (stall && writes === 3) {
              return new Promise((_resolve, reject) => { rejectBlocked = reject; });
            }
          },
          async finish() {},
          async reset() {
            resets++;
            if (rejectBlocked) rejectBlocked(Error("Stream reset"));
          }
        }
      }
    };
  }

  const host = new PrismoHost(api, () => false, 250);
  const stalled = Array.from({ length: 4 }, () => imageStream());
  const requests = stalled.map(item => host.respond(item.stream, "test-peer"));
  await waitFor(() => stalled.every(item => item.writes === 3), "Image transfers did not stall");
  assert.equal(host.activeImageResponses, 4);
  const rejected = imageStream(false);
  await host.respond(rejected.stream, "test-peer");
  assert.equal(JSON.parse(rejected.written[1].toString("utf8")).status, 429);
  await Promise.all(requests);
  assert.equal(host.activeImageResponses, 0);
  assert.ok(stalled.every(item => item.resets === 1));
  assert.equal(host.requests.size, 0);

  const resumed = imageStream(false);
  await host.respond(resumed.stream, "test-peer");
  assert.equal(JSON.parse(resumed.written[1].toString("utf8")).status, 200);
  assert.equal(host.activeImageResponses, 0);

  const cancelledHost = new PrismoHost(api, () => false, 10_000);
  const cancelled = imageStream();
  const request = cancelledHost.respond(cancelled.stream, "test-peer");
  await waitFor(() => cancelled.writes === 3, "Cancelled transfer did not start");
  for (const controller of cancelledHost.requests.keys()) controller.abort();
  await Promise.race([
    request,
    new Promise((_resolve, reject) => setTimeout(() =>
      reject(Error("Cancelled image transfer retained its slot")), 1000))
  ]);
  assert.equal(cancelled.resets, 1);
  assert.equal(cancelledHost.activeImageResponses, 0);
  assert.equal(cancelledHost.requests.size, 0);

  const rpcHost = new PrismoHost(api, () => false, 250);
  const rpcStalled = imageStream(true, "/health");
  await Promise.race([
    rpcHost.respond(rpcStalled.stream, "test-peer"),
    new Promise((_resolve, reject) => setTimeout(() =>
      reject(Error("Stalled API response was not released")), 1500))
  ]);
  assert.equal(rpcStalled.resets, 1);
  assert.equal(rpcHost.activeImageResponses, 0);
  assert.equal(rpcHost.requests.size, 0);

  const rpcCancelled = imageStream(true, "/api/v1/repositories");
  const rpcRequest = rpcHost.respond(rpcCancelled.stream, "test-peer");
  await waitFor(() => rpcCancelled.writes === 3, "API response did not stall");
  for (const controller of rpcHost.requests.keys()) controller.abort();
  await Promise.race([
    rpcRequest,
    new Promise((_resolve, reject) => setTimeout(() =>
      reject(Error("Cancelled API response was not released")), 1000))
  ]);
  assert.equal(rpcCancelled.resets, 1);
  assert.equal(rpcHost.requests.size, 0);

  const stalledUpstream = new PrismoHost({
    inject: () => new Promise(() => {})
  }, () => false, 250);
  const upstreamRequest = imageStream(false, "/health");
  await Promise.race([
    stalledUpstream.respond(upstreamRequest.stream, "test-peer"),
    new Promise((_resolve, reject) => setTimeout(() =>
      reject(Error("Stalled API handler was not released")), 1500))
  ]);
  assert.equal(JSON.parse(upstreamRequest.written[1].toString()).status, 500);
  assert.equal(stalledUpstream.requests.size, 0);
}

void app.whenReady().then(async () => {
  try {
    const { createApp } = await import("../../agent/dist/api.js");
    const { PairingStore } = await import("../../agent/dist/pairing.js");
    const { UpdateStore } = await import("../../agent/dist/updates.js");
    const { addRepository } = await import("../../agent/dist/config.js");
    const source = join(dir, "sample-git-repository");
    await mkdir(source);
    execFileSync("git", ["init", "--quiet", source]);
    await writeFile(join(source, "sample.txt"), "first line\n");
    execFileSync("git", ["-C", source, "add", "sample.txt"]);
    execFileSync("git", ["-C", source, "-c", "user.name=Prismo Test",
      "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial sample"]);
    await writeFile(join(source, "sample.txt"), "first line\nsecond line\n");
    const sample = await addRepository(source);
    const pairing = new PairingStore(join(dir, "paired.json"));
    let approved = false;
    let holdApproval = false;
    let pendingApproval = null;
    api = createApp(pairing, new UpdateStore(join(dir, "updates.json")),
      async (_name, signal) => {
        if (!holdApproval) return approved;
        pendingApproval = signal;
        return new Promise(resolve => {
          if (signal.aborted) return resolve(false);
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      });
    let upstreamClosed = false;
    let delayedResponseStarted = false;
    const totalBytes = 2 * 1024 * 1024;
    api.get("/api/v1/transport-test", async (_request, reply) => {
      reply.header("Content-Length", String(totalBytes));
      return reply.type("application/octet-stream").send(Readable.from((function* () {
        for (let i = 0; i < totalBytes / 65536; i++) yield Buffer.alloc(65536, i);
      })()));
    });
    api.get("/api/v1/transport-delayed", async (_request, reply) => {
      delayedResponseStarted = true;
      await new Promise(resolve => setTimeout(resolve, 200));
      return reply.send({ ready: true });
    });
    api.get("/api/v1/transport-cancel", async (_request, reply) => {
      reply.header("Content-Length", String(64 * 1024 * 1024));
      const body = Readable.from((async function* () {
        try {
          for (let i = 0; i < 1024; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            yield Buffer.alloc(65536, i);
          }
        } finally {
          upstreamClosed = true;
        }
      })());
      return reply.type("application/octet-stream").send(body);
    });
    await api.ready();
    await verifyImageResponseQuota();
    await verifyImageStallRecovery();
    host = new PrismoHost(api, peerID => pairing.hasPeer(peerID));
    await host.start();
    await verifyKotlinClient(host);
    const originalID = host.id;
    const aBuilder = Endpoint.builder();
    aBuilder.applyMinimal();
    aBuilder.alpns([alpn]);
    clientA = await aBuilder.bind();
    const bBuilder = Endpoint.builder();
    bBuilder.applyMinimal();
    bBuilder.alpns([alpn]);
    clientB = await bBuilder.bind();
    const a = await connect(clientA, host);
    const b = await connect(clientB, host);
    assert.equal((await send(a, "GET", "/health")).status, 200);
    const malformed = await a.openBi();
    const invalidSize = Buffer.alloc(4);
    invalidSize.writeUInt32BE(8193);
    await malformed.send.writeAll([...invalidSize]);
    await malformed.send.finish();
    const errorSize = Buffer.from(await malformed.recv.readExact(4)).readUInt32BE();
    const errorHeader = JSON.parse(Buffer.from(
      await malformed.recv.readExact(errorSize)).toString("utf8"));
    assert.equal(errorHeader.status, 500);
    await malformed.recv.readExact(errorHeader.length);
    assert.equal((await send(a, "GET", "/health")).status, 200);
    assert.equal(host.onlinePeers().has(clientA.id().toString()), true);
    assert.equal(host.onlinePeers().has(clientB.id().toString()), true);
    assert.equal((await send(a, "GET", "/api/v1/repositories")).status, 401);
    assert.equal((await send(a, "POST", "/api/v1/pair", {
      code: "not-a-valid-code", name: "Test phone", token: "Q".repeat(43)
    })).status, 401);
    const code = pairing.issue().secret;
    const token = "Q".repeat(43);
    const refused = await send(a, "POST", "/api/v1/pair",
      { code, name: "Test phone", token });
    assert.equal(refused.status, 403);
    assert.ok(pairing.current());
    approved = true;
    const paired = await send(a, "POST", "/api/v1/pair",
      { code, name: "Test phone", token });
    assert.equal(paired.status, 200);
    assert.equal(paired.data.paired, true);
    const repeated = await send(a, "POST", "/api/v1/pair",
      { code, name: "Retry", token });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.paired, true);
    assert.equal((await send(a, "POST", "/api/v1/pair",
      { code, name: "Replay", token: "R".repeat(43) })).status, 401);
    assert.equal((await send(a, "GET", "/api/v1/repositories", undefined, token)).status, 200);
    // Normal mobile reads consume the complete frame and FIN; navigation
    // aborts only requests that are still pending.
    const route = "/api/v1/repositories/" + sample.id;
    const screens = [
      route + "/status", route + "/tree", route + "/commits",
      route + "/file?path=sample.txt", route + "/diff?path=sample.txt&scope=unstaged&full=false"
    ];
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(screens.map(path =>
        send(a, "GET", path, undefined, token)));
      assert.ok(results.every(response => response.status === 200),
        "Repository screens must work after simultaneous tab and file requests");
      const abandoned = await a.openBi();
      const input = requestBytes("GET", route + "/commits", undefined, token);
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(input.length);
      await abandoned.send.writeAll([...prefix]);
      await abandoned.send.writeAll([...input]);
      await abandoned.send.finish();
      await abandoned.recv.stop(0n);
    }
    assert.equal((await send(a, "GET", route + "/tree", undefined, token)).status, 200,
      "Cancelling prior requests must not poison the shared peer connection");
    holdApproval = true;
    const abortedCode = pairing.issue().secret;
    const abandoned = await b.openBi();
    const abandonedInput = requestBytes("POST", "/api/v1/pair",
      { code: abortedCode, name: "Cancelled phone", token: "S".repeat(43) });
    const abandonedLength = Buffer.alloc(4);
    abandonedLength.writeUInt32BE(abandonedInput.length);
    await abandoned.send.writeAll([...abandonedLength]);
    await abandoned.send.writeAll([...abandonedInput]);
    await abandoned.send.finish();
    await waitFor(() => pendingApproval != null, "Pairing dialog did not begin");
    await abandoned.recv.stop(0n);
    await waitFor(() => pendingApproval.aborted,
      "Peer stream cancellation did not reach pairing approval", 4000);
    assert.equal(pairing.hasPeer(clientB.id().toString()), false);
    assert.ok(pairing.current(), "Cancelled pairing must not consume QR code");
    holdApproval = false;
    pairing.cancel();
    const previousUserData = app.getPath("userData");
    app.setPath("userData", join(dir, "idle-electron"));
    const idleHost = new PrismoHost(api, peerID => pairing.hasPeer(peerID), 45_000, 200);
    const originalCancelRequest = api.cancelRequest.bind(api);
    const cancelledByShutdown = [];
    api.cancelRequest = requestID => {
      cancelledByShutdown.push(requestID);
      originalCancelRequest(requestID);
    };
    try {
      await idleHost.start();
      assert.notEqual(idleHost.id, host.id, "Idle test requires a distinct endpoint");
      const pairedIdle = await connect(clientA, idleHost);
      assert.equal(pairing.hasPeer(clientA.id().toString()), true,
        "Idle test peer is not authorized");
      assert.equal((await send(pairedIdle, "GET", "/health")).status, 200);
      assert.equal(idleHost.onlinePeers().has(clientA.id().toString()), true,
        "Paired session closed after health; reason=" + pairedIdle.closeReason());
      const unpairedIdle = await connect(clientB, idleHost);
      assert.equal((await send(unpairedIdle, "GET", "/health")).status, 200);
      await waitFor(() => !idleHost.onlinePeers().has(clientB.id().toString()),
        "Unpaired idle session was not released", 3000);
      assert.equal(idleHost.onlinePeers().has(clientA.id().toString()), true,
        "Paired session must not expire with the unpaired idle timeout");
      assert.equal((await send(pairedIdle, "GET", "/api/v1/repositories",
        undefined, token)).status, 200);
      // Shutdown must drain an active response before dropping its connection.
      const inFlight = await pairedIdle.openBi();
      const input = requestBytes("GET", "/api/v1/transport-cancel", undefined, token);
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(input.length);
      await inFlight.send.writeAll([...prefix]);
      await inFlight.send.writeAll([...input]);
      await inFlight.send.finish();
      const headerSize = Buffer.from(await inFlight.recv.readExact(4)).readUInt32BE();
      const header = JSON.parse(Buffer.from(
        await inFlight.recv.readExact(headerSize)).toString("utf8"));
      assert.equal(header.status, 200);
      assert.ok(idleHost.requests.size > 0, "The streaming request must still be active");
      // An unfinished request header must also be cancelled and drained.
      const partial = await pairedIdle.openBi();
      await partial.send.writeAll([0, 0]);
      await waitFor(() => idleHost.requests.size >= 2,
        "The partial request header was not accepted");
      const stopStarted = Date.now();
      await idleHost.stop();
      assert.ok(Date.now() - stopStarted < 8_000,
        "Shutdown waited for a stalled native request header");
      assert.ok(cancelledByShutdown.length >= 2,
        "Shutdown did not propagate cancellation to Agent requests");
      assert.equal(idleHost.requests.size, 0, "Shutdown retained active requests");
      assert.equal(idleHost.pending.size, 0, "Shutdown retained an open connection task");
      assert.equal(idleHost.connections.size, 0, "Shutdown retained an open connection");
    } finally {
      api.cancelRequest = originalCancelRequest;
      await idleHost.stop();
      app.setPath("userData", previousUserData);
    }
    for (let i = 0; i < 3; i++) await connect(clientB, host);
    const unpairedCount = () => [...host.connections].filter(connection =>
      connection.remoteId().toString() === clientB.id().toString()).length;
    await waitFor(() => unpairedCount() === 4,
      "Unpaired connection quota should allow four connections");
    try { await connect(clientB, host); } catch { /* An over-quota handshake may be refused. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(unpairedCount(), 4, "An unpaired peer cannot fill reserved paired slots");
    const pairedConnection = await connect(clientA, host);
    assert.equal((await send(pairedConnection, "GET", "/api/v1/repositories",
      undefined, token)).status, 200);
    const large = await send(a, "GET", "/api/v1/transport-test", undefined, token, true);
    assert.equal(large.status, 200);
    assert.equal(large.data.length, totalBytes);
    for (let i = 0; i < totalBytes / 65536; i++) {
      assert.equal(large.data[i * 65536], i);
    }
    // A stopped QUIC receive before the injected response is ready must not
    // emit light-my-request's unhandled AbortError in Electron's main process.
    const unexpected = [];
    const onUnexpected = error => unexpected.push(error);
    process.on("uncaughtException", onUnexpected);
    process.on("unhandledRejection", onUnexpected);
    try {
      const waiting = await a.openBi();
      const delayed = requestBytes("GET", "/api/v1/transport-delayed", undefined, token);
      const delayedSize = Buffer.alloc(4);
      delayedSize.writeUInt32BE(delayed.length);
      await waiting.send.writeAll([...delayedSize]);
      await waiting.send.writeAll([...delayed]);
      await waiting.send.finish();
      await waitFor(() => delayedResponseStarted, "Delayed request did not start");
      await waiting.recv.stop(0n);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.deepEqual(unexpected, [],
        "Cancelled injected response caused an uncaught main-process error");
    } finally {
      process.off("uncaughtException", onUnexpected);
      process.off("unhandledRejection", onUnexpected);
    }
    await cancelStream(a, "/api/v1/transport-cancel", token);
    await Promise.race([
      (async () => {
        while (!upstreamClosed) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(Error("Cancelled response was not released")), 8000))
    ]);
    assert.equal(upstreamClosed, true);
    assert.equal((await send(b, "GET", "/api/v1/repositories", undefined, token)).status, 401);
    assert.equal(pairing.list().length, 1);
    const registered = pairing.list()[0];
    assert.equal(pairing.peerID(registered.id), clientA.id().toString());
    await pairing.revoke(registered.id);
    assert.equal((await send(a, "GET", "/api/v1/repositories", undefined, token)).status, 401);
    await host.disconnectPeer(clientA.id().toString());
    await Promise.race([
      (async () => {
        while (host.onlinePeers().has(clientA.id().toString())) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(Error("Revoked device connection remained open")), 3000))
    ]);
    assert.equal(host.onlinePeers().has(clientB.id().toString()), true);
    await host.stop();
    assert.equal(host.onlinePeers().size, 0);
    await flushTransportLog();
    const transportLog = await readFile(join(dir, "electron", "transport.log"), "utf8");
    assert.match(transportLog, /\bconnected\b/);
    assert.match(transportLog, /\bdisconnected\b/);
    assert.match(transportLog, /response\.request-header InvalidRequest/);
    assert.ok(!transportLog.includes(token), "Transport logs must not contain credentials");
    assert.ok(!transportLog.includes(clientA.id().toString()),
      "Transport logs must not contain peer identities");
    await host.start();
    assert.equal(host.id, originalID);
    writeFileSync(resultFile, "PASS: Iroh pairing/auth/revoke/identity + streaming/cancel/logging\n");
  } catch (error) {
    writeFileSync(resultFile, "FAIL: " + String(error?.stack || error) + "\n");
    process.exitCode = 1;
  } finally {
    for (const conn of connections) {
      try { conn.close(0n, []); } catch {}
    }
    if (clientA) await clientA.close();
    if (clientB) await clientB.close();
    if (host) await host.stop();
    if (api) await api.close();
    await rm(dir, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}).catch(async error => {
  writeFileSync(resultFile, "STARTUP_FAIL: " + String(error) + "\n");
  app.exit(1);
});

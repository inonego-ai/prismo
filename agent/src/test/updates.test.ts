import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import test from "node:test";
import { PairingStore } from "../pairing.js";
import { UpdateStore } from "../updates.js";
import { createApp } from "../api.js";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const TEST_PEER = "a".repeat(64);
const TEST_TOKEN = "A".repeat(43);

test("real UpdateStore forwards client cancellation to the GitHub APK fetch", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-fetch-abort-"));
  const config = join(base, "release.json");
  const apk = Buffer.from("apk");
  const manifest = Buffer.from(JSON.stringify({
    packageName: "dev.prismo.app", versionCode: 7, versionName: "0.2.0",
    apk: "app-release.apk", size: apk.length, sha256: hash(apk)
  }));
  const releaseURL = "https://github.com/example/prismo/releases/download/v0.2.0/";
  const asset = (name: string, content: Buffer) => ({
    name, state: "uploaded", size: content.length, digest: "sha256:" + hash(content),
    browser_download_url: releaseURL + name
  });
  const release = { tag_name: "v0.2.0", draft: false, prerelease: false,
    assets: [asset("prismo-update.json", manifest), asset("app-release.apk", apk)] };
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  let remoteSignal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) return new Response(JSON.stringify(release));
    if (url === releaseURL + "prismo-update.json") return new Response(manifest);
    if (url === releaseURL + "app-release.apk") {
      remoteSignal = init?.signal as AbortSignal | undefined;
      started();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(Error("aborted"), { name: "AbortError" }));
        if (remoteSignal?.aborted) abort();
        else remoteSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response("", { status: 404 });
  };
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    const controller = new AbortController();
    const pending = updates.download(controller.signal);
    await requested;
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(remoteSignal?.aborted, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Fastify request errors retain their client status codes", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-http-errors-"));
  const app = createApp(new PairingStore(join(base, "paired.json")),
    new UpdateStore(), async () => true);
  try {
    const url = "/api/v1/pair";
    const peerID = "c".repeat(64);
    const malformed = await app.inject({
      method: "POST", url, headers: { "content-type": "application/json", "x-prismo-peer": peerID }, payload: "{"
    });
    assert.equal(malformed.statusCode, 400);
    const oversized = await app.inject({
      method: "POST", url, headers: { "x-prismo-peer": peerID }, payload: { code: "a".repeat(2048) }
    });
    assert.equal(oversized.statusCode, 413);
    const unsupported = await app.inject({
      method: "POST", url, headers: { "content-type": "application/xml", "x-prismo-peer": peerID }, payload: "<x/>"
    });
    assert.equal(unsupported.statusCode, 415);
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("client disconnect cancels an outstanding APK fetch", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-disconnect-"));
  let signalSeen: AbortSignal | undefined;
  let started!: () => void;
  let cancelled!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const cancelledPromise = new Promise<void>(resolve => { cancelled = resolve; });
  const updates = new UpdateStore(join(base, "release.json"));
  updates.download = async (signal?: AbortSignal) => {
    signalSeen = signal;
    started();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        cancelled();
        reject(Error("Remote download cancelled"));
      }, { once: true });
    });
  };
  const pairing = new PairingStore(join(base, "paired.json"));
  const app = createApp(pairing, updates, async () => true);
  const client = new AbortController();
  try {
    const code = pairing.issue().secret;
    const paired = await app.inject({
      method: "POST", url: "/api/v1/pair", payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER }
    });
    assert.equal(paired.statusCode, 200);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(address + "/api/v1/app/update/download", {
      headers: { authorization: "Bearer " + TEST_TOKEN, "x-prismo-peer": TEST_PEER },
      signal: client.signal
    });
    await startedPromise;
    client.abort();
    await Promise.all([request.catch(() => {}), cancelledPromise]);
    assert.equal(signalSeen?.aborted, true);
  } finally {
    client.abort();
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("malformed GitHub release assets are rejected without crashing update lookup", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-malformed-release-"));
  const config = join(base, "release.json");
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    tag_name: "v0.2.0", draft: false, prerelease: false, assets: [null]
  }));
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    assert.equal(await updates.latest(), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("concurrent update lookups share one in-flight release request", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-lookup-"));
  const config = join(base, "release.json");
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return pending;
  };
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    const lookups = Array.from({ length: 8 }, () => updates.latest());
    assert.equal(requests, 1);
    complete(new Response("", { status: 404 }));
    assert.deepEqual(await Promise.all(lookups), Array(8).fill(null));
    assert.equal(await updates.latest(), null);
    assert.equal(requests, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("release metadata exceeding the limit is cancelled and a later lookup can retry", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-release-limit-"));
  const config = join(base, "release.json");
  let cancelled = false;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    if (++calls > 1) return new Response("", { status: 404 });
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; }
    }));
  };
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    await assert.rejects(updates.latest(), /too large/);
    assert.equal(cancelled, true);
    assert.equal(await updates.latest(), null);
    assert.equal(calls, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("authenticated APK transfers are bounded until response streams close", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-transfer-"));
  let releaseGate!: () => void;
  let twoStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const ready = new Promise<void>(resolve => { twoStarted = resolve; });
  const updates = new UpdateStore(join(base, "release.json"));
  let started = 0;
  updates.download = async () => {
    if (++started === 2) twoStarted();
    await gate;
    return {
      update: { packageName: "dev.prismo.app", versionCode: 7,
        versionName: "0.2.0", size: 3, sha256: hash(Buffer.from("apk")) },
      stream: Readable.from([Buffer.from("apk")])
    };
  };
  const pairing = new PairingStore(join(base, "paired.json"));
  const app = createApp(pairing, updates, async () => true);
  try {
    const code = pairing.issue().secret;
    const paired = await app.inject({
      method: "POST", url: "/api/v1/pair", payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER }
    });
    assert.equal(paired.statusCode, 200);
    const headers = { authorization: "Bearer " + TEST_TOKEN, "x-prismo-peer": TEST_PEER };
    const request = { method: "GET" as const,
      url: "/api/v1/app/update/download", headers };
    const first = app.inject(request);
    const second = app.inject(request);
    await ready;
    const blocked = await app.inject(request);
    assert.equal(blocked.statusCode, 429);
    releaseGate();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(response => response.statusCode), [200, 200]);
    assert.deepEqual(responses.map(response => response.body), ["apk", "apk"]);
    assert.equal((await app.inject(request)).statusCode, 200);
  } finally {
    releaseGate();
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("server shutdown closes an in-progress APK stream", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-shutdown-"));
  const pairing = new PairingStore(join(base, "paired.json"));
  const updates = new UpdateStore(join(base, "release.json"));
  const stream = new PassThrough();
  updates.download = async () => ({
    update: { packageName: "dev.prismo.app", versionCode: 7, versionName: "0.2.0",
      size: 100, sha256: hash(Buffer.from("apk")) },
    stream
  });
  const app = createApp(pairing, updates, async () => true);
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = pairing.issue().secret;
    const paired = await app.inject({
      method: "POST", url: "/api/v1/pair", payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER }
    });
    assert.equal(paired.statusCode, 200);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(address + "/api/v1/app/update/download", {
      headers: { authorization: "Bearer " + TEST_TOKEN, "x-prismo-peer": TEST_PEER },
      signal: AbortSignal.timeout(5000)
    });
    stream.write(Buffer.from("a"));
    const response = await request;
    assert.equal(response.status, 200);
    const closed = app.close();
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Agent shutdown stalled")), 3000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    stream.destroy();
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("only paired clients can retrieve the newest published release", async () => {
  const root = await mkdtemp(join(tmpdir(), "prismo-update-"));
  const config = join(root, "release-config.json");
  const apk = Buffer.from("mock signed release payload");
  const { version: versionName } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };
  const manifest = Buffer.from(JSON.stringify({
    packageName: "dev.prismo.app", versionCode: 7, versionName,
    apk: "app-release.apk", size: apk.length, sha256: hash(apk)
  }));
  const urlBase = `https://github.com/example/prismo/releases/download/v${versionName}/`;
  const release = {
    tag_name: `v${versionName}`, draft: false, prerelease: false,
    assets: [
      {
        name: "prismo-update.json", state: "uploaded",
        size: manifest.length, digest: "sha256:" + hash(manifest),
        browser_download_url: urlBase + "prismo-update.json"
      },
      {
        name: "app-release.apk", state: "uploaded",
        size: apk.length, digest: "sha256:" + hash(apk),
        browser_download_url: urlBase + "app-release.apk"
      }
    ]
  };
  const mockFetch: typeof fetch = async input => {
    const url = String(input);
    if (url === "https://api.github.com/repos/example/prismo/releases/latest") {
      return new Response(JSON.stringify(release), { status: 200 });
    }
    if (url === urlBase + "prismo-update.json") return new Response(manifest);
    if (url === urlBase + "app-release.apk") return new Response(apk);
    return new Response("Not found", { status: 404 });
  };
  await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
  const pairing = new PairingStore(join(root, "paired-endpoints.json"));
  const updates = new UpdateStore(config, mockFetch);
  const app = createApp(pairing, updates, async () => true);
  try {
    const unauth = await app.inject({ method: "GET", url: "/api/v1/app/update" });
    assert.equal(unauth.statusCode, 401);
    const code = pairing.issue().secret;
    const response = await app.inject({
      method: "POST", url: "/api/v1/pair", payload: { code, token: TEST_TOKEN }, headers: { "x-prismo-peer": TEST_PEER }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().paired, true);
    const headers = { authorization: "Bearer " + TEST_TOKEN, "x-prismo-peer": TEST_PEER };
    const current = await app.inject({
      method: "GET", url: "/api/v1/app/update", headers
    });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().configured, true);
    assert.equal(current.json().update.sha256, hash(apk));
    const download = await app.inject({
      method: "GET", url: "/api/v1/app/update/download", headers
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, apk.toString());
    assert.equal(download.headers["content-type"], "application/vnd.android.package-archive");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

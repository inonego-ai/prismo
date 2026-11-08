import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UpdateStore } from "../updates.js";

test("oversized release manifest cancels its source", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-manifest-"));
  const config = join(base, "release.json");
  const prefix = "https://github.com/example/prismo/releases/download/v0.2.0/";
  const release = {
    tag_name: "v0.2.0", draft: false, prerelease: false, assets: [
      { name: "prismo-update.json", size: 10, state: "uploaded", digest: null,
        browser_download_url: prefix + "prismo-update.json" },
      { name: "app-release.apk", size: 3, state: "uploaded",
        digest: "sha256:" + "a".repeat(64),
        browser_download_url: prefix + "app-release.apk" }
    ]
  };
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16385)); },
    cancel() { cancelled = true; }
  });
  const fetcher: typeof fetch = async input =>
    String(input).endsWith("/releases/latest")
      ? new Response(JSON.stringify(release)) : new Response(stream);
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    await assert.rejects(updates.latest(), /Release asset too large/);
    assert.equal(cancelled, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("missing release responses cancel unread bodies", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-release-404-"));
  const config = join(base, "release.json");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; }
  });
  const fetcher: typeof fetch = async () => new Response(body, { status: 404 });
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    assert.equal(await updates.latest(), null);
    assert.equal(cancelled, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("manifest download failures cancel unread streams", async () => {
  const base = await mkdtemp(join(tmpdir(), "prismo-release-error-"));
  const config = join(base, "release.json");
  const prefix = "https://github.com/example/prismo/releases/download/v0.2.0/";
  const release = { tag_name: "v0.2.0", draft: false, prerelease: false,
    assets: [
      { name: "prismo-update.json", size: 10, state: "uploaded", digest: null,
        browser_download_url: prefix + "prismo-update.json" },
      { name: "app-release.apk", size: 3, state: "uploaded",
        digest: "sha256:" + "a".repeat(64),
        browser_download_url: prefix + "app-release.apk" }
    ] };
  let cancelled = false;
  const manifest = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; }
  });
  const fetcher: typeof fetch = async input => String(input).endsWith("/releases/latest")
    ? new Response(JSON.stringify(release))
    : new Response(manifest, { status: 503 });
  try {
    await writeFile(config, JSON.stringify({ github: { owner: "example", repo: "prismo" } }));
    const updates = new UpdateStore(config, fetcher);
    await updates.initialize();
    await assert.rejects(updates.latest(), /release download failed: 503/);
    assert.equal(cancelled, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

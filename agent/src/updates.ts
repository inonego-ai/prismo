import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { loadGitHubSource, DEFAULT_RELEASE_CONFIG, type GitHubSource } from "./releaseConfig.js";

export type UpdateInfo = {
  versionCode: number;
  versionName: string;
  packageName: string;
  size: number;
  sha256: string;
};

type ReleaseAsset = {
  name: string; size: number; state: string;
  digest: string | null; browser_download_url: string;
};
type Release = {
  tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[];
};
type Descriptor = UpdateInfo & { apk: string };
type Published = { info: UpdateInfo; asset: ReleaseAsset };
const MAX_APK_BYTES = 150 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;
const PACKAGE_NAME = "dev.prismo.app";
const GITHUB_AGENT = "Prismo-Updater";
const CACHE_MS = 60_000;

function validAsset(
  asset: ReleaseAsset | undefined, source: GitHubSource, tag: string
): asset is ReleaseAsset {
  if (!asset || asset.state !== "uploaded" || !Number.isSafeInteger(asset.size)) return false;
  try {
    const parsed = new URL(asset.browser_download_url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      && !parsed.search && !parsed.hash
      && parsed.pathname === "/" + source.owner + "/" + source.repo
        + "/releases/download/" + tag + "/" + asset.name;
  } catch { return false; }
}
async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw Error("Empty release asset");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("Release asset too large");
      parts.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the read error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

export class UpdateStore {
  private source: GitHubSource | null = null;
  private cached: { until: number; result: Published | null } | null = null;
  private resolving: Promise<Published | null> | null = null;

  constructor(
    private readonly configPath = DEFAULT_RELEASE_CONFIG,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async initialize(): Promise<void> {
    this.source = await loadGitHubSource(this.configPath);
  }

  get configured(): boolean { return this.source !== null; }

  private async fetchAsset(url: string, timeout: number, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetcher(url, {
      headers: { "User-Agent": GITHUB_AGENT, Accept: "application/octet-stream" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("GitHub release download failed: " + response.status);
    }
    return response;
  }

  private async resolveLatest(): Promise<Published | null> {
    const source = this.source;
    if (!source) return null;
    const api = "https://api.github.com/repos/" + source.owner + "/" +
      source.repo + "/releases/latest";
    const response = await this.fetcher(api, {
      headers: {
        "User-Agent": GITHUB_AGENT,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(12_000)
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("GitHub release lookup failed: " + response.status);
    }
    const metadata: unknown = JSON.parse(
      (await readBounded(response, MAX_RELEASE_BYTES)).toString("utf8")
    );
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const release = metadata as Release;
    if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean"
      || typeof release.tag_name !== "string" || !Array.isArray(release.assets)
      || !release.assets.every(asset => !!asset && typeof asset === "object"
        && !Array.isArray(asset))) return null;
    if (release.draft || release.prerelease ||
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name)) return null;
    const manifest = release.assets.find(asset => asset.name === "prismo-update.json");
    const apk = release.assets.find(asset => asset.name === "app-release.apk");
    if (!validAsset(manifest, source, release.tag_name) ||
      !validAsset(apk, source, release.tag_name) ||
      manifest.size < 1 || manifest.size > MAX_MANIFEST_BYTES ||
      apk.size < 1 || apk.size > MAX_APK_BYTES ||
      !/^sha256:[a-f0-9]{64}$/.test(apk.digest ?? "")) return null;

    const manifestResponse = await this.fetchAsset(manifest.browser_download_url, 12_000);
    const raw = await readBounded(manifestResponse, MAX_MANIFEST_BYTES);
    if (raw.length !== manifest.size) return null;
    if (manifest.digest && manifest.digest !== "sha256:" +
      createHash("sha256").update(raw).digest("hex")) return null;

    const decoded: unknown = JSON.parse(raw.toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const data = decoded as Descriptor;
    if (data.packageName !== PACKAGE_NAME || data.apk !== apk.name
      || !Number.isSafeInteger(data.versionCode) || data.versionCode < 1
      || data.versionName !== release.tag_name.slice(1)
      || data.size !== apk.size
      || data.sha256 !== apk.digest?.slice(7)) return null;
    return { info: {
      packageName: PACKAGE_NAME, versionCode: data.versionCode,
      versionName: data.versionName, size: data.size, sha256: data.sha256
    }, asset: apk };
  }

  private async published(): Promise<Published | null> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.result;
    if (this.resolving) return this.resolving;
    const lookup = this.resolveLatest().then(result => {
      this.cached = { until: Date.now() + CACHE_MS, result };
      return result;
    });
    this.resolving = lookup;
    try { return await lookup; }
    finally { this.resolving = null; }
  }

  async latest(): Promise<{ info: UpdateInfo } | null> {
    const found = await this.published();
    return found ? { info: found.info } : null;
  }

  async download(signal?: AbortSignal): Promise<{ update: UpdateInfo; stream: Readable } | null> {
    signal?.throwIfAborted();
    const release = await this.published();
    signal?.throwIfAborted();
    if (!release) return null;
    const response = await this.fetchAsset(release.asset.browser_download_url, 180_000, signal);
    const length = response.headers.get("content-length");
    if (length && Number(length) !== release.info.size) {
      await response.body?.cancel();
      throw Error("Release APK size mismatch");
    }
    if (!response.body) throw Error("Release APK is empty");
    let transferred = 0;
    const digest = createHash("sha256");
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length;
        digest.update(chunk);
        callback(transferred > release.info.size
          ? Error("Release APK exceeded declared size") : null, chunk);
      },
      flush(callback) {
        if (transferred !== release.info.size) {
          callback(Error("Release APK incomplete"));
        } else if (digest.digest("hex") !== release.info.sha256) {
          callback(Error("Release APK checksum mismatch"));
        } else {
          callback();
        }
      }
    });
    const source = Readable.fromWeb(response.body as
      unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    source.on("error", error => limit.destroy(error));
    limit.once("close", () => source.destroy());
    if (signal) {
      const abort = () => {
        source.destroy();
        limit.destroy();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      limit.once("close", () => signal.removeEventListener("abort", abort));
    }
    return { update: release.info, stream: source.pipe(limit) };
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, writeJsonAtomically } from "./config.js";

type Device = { id: string; digest: string; pairedAt: string; name: string; peerID: string };
type Pending = { secret: string; expiresAt: number };
const DURATION_MS = 120_000;
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
const PEER_ID_RE = /^[0-9a-f]{64}$/;
export function deviceName(value: unknown): string {
  if (typeof value !== "string") return "Android 기기";
  const name = value.replace(/[\u0000-\u001f]/g, "").trim()
    .slice(0, 40).replace(/[\uD800-\uDBFF]$/, "");
  return name || "Android 기기";
}
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
export class PairingStore {
  private devices: Device[] = [];
  private pending: Pending | null = null;
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(path = join(dirname(configPath()), "paired-endpoints.json")) {
    this.path = path;
  }
  async initialize(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || !("devices" in parsed)
        || !Array.isArray(parsed.devices)
        || !parsed.devices.every((item: unknown) =>
          !!item && typeof item === "object" && "digest" in item
          && typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest)
          && "pairedAt" in item && typeof item.pairedAt === "string"
          && "id" in item && typeof item.id === "string"
          && /^[0-9a-f-]{36}$/.test(item.id)
          && "name" in item && typeof item.name === "string"
          && item.name.length > 0 && item.name.length <= 40
          && "peerID" in item && typeof item.peerID === "string"
          && PEER_ID_RE.test(item.peerID))) {
        throw Error("Invalid device credentials");
      }
      this.devices = parsed.devices as Device[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async persist(devices: Device[]): Promise<void> {
    await writeJsonAtomically(this.path, { devices });
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action);
    this.mutation = result.then(() => {}, () => {});
    return result;
  }
  issue(now = Date.now()): { secret: string; expiresAt: number } {
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = now + DURATION_MS;
    this.pending = { secret, expiresAt };
    return { secret, expiresAt };
  }
  current(now = Date.now()): { secret: string; expiresAt: number } | null {
    const pending = this.pending;
    if (!pending) return null;
    if (now >= pending.expiresAt) {
      this.pending = null;
      return null;
    }
    return { secret: pending.secret, expiresAt: pending.expiresAt };
  }
  matches(secret: unknown, peerID: unknown): boolean {
    const pending = this.current();
    return typeof secret === "string" && CREDENTIAL_RE.test(secret)
      && typeof peerID === "string" && PEER_ID_RE.test(peerID)
      && !!pending && timingSafeEqual(digest(secret), digest(pending.secret));
  }
  cancel(): void { this.pending = null; }
  count(): number { return this.devices.length; }
  hasPeer(peerID: string): boolean {
    return this.loaded && this.devices.some(device => device.peerID === peerID);
  }
  peerID(id: string): string | null {
    return this.devices.find(device => device.id === id)?.peerID ?? null;
  }
  list(onlinePeers: ReadonlySet<string> = new Set()):
    { id: string; name: string; pairedAt: string; online: boolean }[] {
    return this.devices.map(device => ({
      id: device.id, name: device.name,
      pairedAt: device.pairedAt, online: onlinePeers.has(device.peerID)
    }));
  }
  revoke(id: string): Promise<void> {
    return this.serialize(async () => {
      const devices = this.devices.filter(device => device.id !== id);
      if (devices.length === this.devices.length) return;
      await this.persist(devices);
      this.devices = devices;
    });
  }
  authorized(header: string | undefined, peerID?: string): boolean {
    if (!this.loaded || !PEER_ID_RE.test(peerID ?? "") ||
      typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    if (!CREDENTIAL_RE.test(token)) return false;
    const candidate = digest(token);
    return this.devices.some(device => device.peerID === peerID && timingSafeEqual(
      candidate, Buffer.from(device.digest, "hex")
    ));
  }
  accept(secret: unknown, label?: unknown, peerID?: string,
         token?: unknown, signal?: AbortSignal): Promise<boolean> {
    return this.serialize(async () => {
      if (signal?.aborted) return false;
      if (typeof token !== "string" || !CREDENTIAL_RE.test(token) ||
        typeof peerID !== "string" || !PEER_ID_RE.test(peerID)) return false;
      if (this.authorized("Bearer " + token, peerID)) return true;
      if (!this.matches(secret, peerID)) return false;
      this.pending = null;
      const name = deviceName(label);
      const devices = [...this.devices.filter(device => device.peerID !== peerID), {
        id: randomUUID(), digest: digest(token).toString("hex"),
        pairedAt: new Date().toISOString(), name, peerID
      }];
      await this.persist(devices);
      this.devices = devices;
      return true;
    });
  }
}

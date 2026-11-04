import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, writeJsonAtomically } from "./config.js";

type Device = { digest: string; pairedAt: string };
type Pending = { secret: string; expiresAt: number };
const DURATION_MS = 120_000;
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
export class PairingStore {
  private devices: Device[] = [];
  private pending: Pending | null = null;
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(path = join(dirname(configPath()), "paired-devices.json")) {
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
          && "pairedAt" in item && typeof item.pairedAt === "string")) {
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
  cancel(): void { this.pending = null; }
  count(): number { return this.devices.length; }
  authorized(header: string | undefined): boolean {
    if (!this.loaded || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    if (!CREDENTIAL_RE.test(token)) return false;
    const candidate = digest(token);
    return this.devices.some(device => timingSafeEqual(
      candidate, Buffer.from(device.digest, "hex")
    ));
  }
  accept(secret: unknown): Promise<string | null> {
    return this.serialize(async () => {
      const pending = this.current();
      if (typeof secret !== "string" || !CREDENTIAL_RE.test(secret) || !pending) return null;
      if (!timingSafeEqual(digest(secret), digest(pending.secret))) return null;
      this.pending = null;
      const token = randomBytes(32).toString("base64url");
      const devices = [...this.devices, {
        digest: digest(token).toString("hex"), pairedAt: new Date().toISOString()
      }];
      await this.persist(devices);
      this.devices = devices;
      return token;
    });
  }
  revokeAll(): Promise<void> {
    this.cancel();
    return this.serialize(async () => {
      await this.persist([]);
      this.devices = [];
    });
  }
}

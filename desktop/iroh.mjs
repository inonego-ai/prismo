import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { Endpoint, SecretKey } from "@number0/iroh";
import { logTransportEvent, logTransportFailure } from "./transport-log.mjs";

const ALPN = Array.from(Buffer.from("prismo/git/1", "utf8"));
const MAX_REQUEST = 8192;
const MAX_RESPONSE = 160 * 1024 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_HANDSHAKES = 4;
const MAX_UNPAIRED_CONNECTIONS = 4;
const MAX_STREAMS_PER_CONNECTION = 8;
const MAX_ACTIVE_IMAGE_RESPONSES = 4;
const RESPONSE_IDLE_TIMEOUT_MS = 45_000;
const RESPONSE_CLEANUP_TIMEOUT_MS = 2_000;
const REQUEST_HEADER_TIMEOUT_MS = 15_000;
const PAIR_APPROVAL_TIMEOUT_MS = 90_000;
const UPDATE_DOWNLOAD_HEADER_TIMEOUT_MS = 270_000;
const UNPAIRED_IDLE_TIMEOUT_MS = 60_000;

async function secretKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw Error("기기 정보를 보호할 수 없습니다.");
  }
  const file = join(app.getPath("userData"), "device-key.dat");
  try {
    const encrypted = await readFile(file);
    const decoded = safeStorage.decryptString(encrypted);
    const bytes = Buffer.from(decoded, "base64");
    if (bytes.length !== 32) throw Error("Invalid device identity");
    return Array.from(bytes);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const bytes = SecretKey.generate().toBytes();
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(file, safeStorage.encryptString(Buffer.from(bytes).toString("base64")), {
    flag: "wx", mode: 0o600
  });
  return bytes;
}

function bytes(value) {
  return Array.from(value);
}

async function within(promise, timeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Connection timed out")), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withResponseProgress(promise, signal, timeout) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        onAbort = () => reject(Error("Response transfer cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => reject(Error("Response transfer stalled")), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function sendHeader(stream, metadata) {
  const header = Buffer.from(JSON.stringify(metadata), "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  await stream.writeAll(bytes(size));
  await stream.writeAll(bytes(header));
}

async function sendFrame(stream, metadata, payload) {
  await sendHeader(stream, metadata);
  await stream.writeAll(bytes(payload));
  await stream.finish();
}

export class PrismoHost {
  constructor(api, isPairedPeer = () => false, responseIdleTimeout = RESPONSE_IDLE_TIMEOUT_MS,
    unpairedIdleTimeout = UNPAIRED_IDLE_TIMEOUT_MS) {
    this.api = api;
    this.isPairedPeer = isPairedPeer;
    this.responseIdleTimeout = responseIdleTimeout;
    this.unpairedIdleTimeout = unpairedIdleTimeout;
    this.handshakes = 0;
    this.endpoint = null;
    this.pending = new Set();
    this.connections = new Set();
    this.requests = new Map();
    this.activeImageResponses = 0;
  }

  get id() {
    return this.endpoint?.id().toString() ?? null;
  }

  onlinePeers() {
    return new Set([...this.connections].map(connection => connection.remoteId().toString()));
  }

  async disconnectPeer(peerID) {
    for (const [request, owner] of this.requests) {
      if (owner === peerID) request.abort();
    }
    await Promise.allSettled([...this.connections]
      .filter(connection => connection.remoteId().toString() === peerID)
      .map(connection => connection.close(0n, [])));
  }

  async start() {
    const key = await secretKey();
    const endpoint = await Endpoint.bind({ secretKey: key, alpns: [ALPN] });
    this.endpoint = endpoint;
    this.handshakes = 0;
    void this.acceptLoop(endpoint);
    return this.id;
  }

  async stop() {
    const current = this.endpoint;
    this.endpoint = null;
    for (const request of this.requests.keys()) request.abort();
    // Closing active connections also interrupts native acceptBi/readExact.
    // A successful stop must not leave request tasks owned by this host.
    await Promise.allSettled([...this.connections].map(connection =>
      connection.close(0n, [])));
    if (current) await current.close();
    try {
      await within(Promise.allSettled([...this.pending]),
        REQUEST_HEADER_TIMEOUT_MS + RESPONSE_CLEANUP_TIMEOUT_MS + 3_000);
    } catch (error) {
      logTransportFailure("drain", error);
      throw error;
    }
    if (this.pending.size || this.connections.size || this.requests.size) {
      throw Error("Iroh host did not drain its requests");
    }
  }

  async acceptLoop(endpoint) {
    while (!endpoint.isClosed()) {
      try {
        const incoming = await endpoint.acceptNext();
        if (!incoming) return;
        if (this.pending.size >= MAX_CONNECTIONS ||
            this.handshakes >= MAX_HANDSHAKES) {
          await incoming.refuse();
          continue;
        }
        this.handshakes++;
        const task = this.handleConnection(incoming, endpoint).catch(error => {
          if (this.endpoint === endpoint) logTransportFailure("connection", error);
        });
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
      } catch (error) {
        if (endpoint.isClosed()) return;
        logTransportFailure("accept", error);
      }
    }
  }

  async handleConnection(incoming, endpoint) {
    let connection;
    try {
      const handshake = await within(incoming.accept(), REQUEST_HEADER_TIMEOUT_MS);
      const protocol = await within(handshake.alpn(), REQUEST_HEADER_TIMEOUT_MS);
      if (!Buffer.from(protocol).equals(Buffer.from(ALPN))) return;
      const connecting = handshake.connect();
      try {
        connection = await within(connecting, REQUEST_HEADER_TIMEOUT_MS);
      } catch (error) {
        void connecting.then(late => late.close(0n, []), () => {});
        throw error;
      }
    } finally {
      if (this.endpoint === endpoint) this.handshakes--;
    }
    if (this.endpoint !== endpoint) {
      connection.close(0n, []);
      return;
    }
    const peerID = connection.remoteId().toString();
    const unpaired = [...this.connections].filter(active =>
      !this.isPairedPeer(active.remoteId().toString())).length;
    if (!this.isPairedPeer(peerID) && unpaired >= MAX_UNPAIRED_CONNECTIONS) {
      connection.close(0n, []);
      return;
    }
    this.connections.add(connection);
    logTransportEvent("connected");
    const active = new Set();
    const controllers = new Set();
    try {
      const acceptStream = () => connection.acceptBi()
        .then(stream => ({ stream }), error => ({ error }));
      let nextStream = acceptStream();
      for (;;) {
        let accepted;
        try {
          accepted = active.size
            ? await Promise.race([nextStream, ...active])
            : this.isPairedPeer(peerID)
              ? await nextStream
              : await within(nextStream, this.unpairedIdleTimeout);
        } catch {
          return;
        }
        if (!accepted) continue;
        if (accepted.error) return;
        const stream = accepted.stream;
        nextStream = acceptStream();
        if (active.size >= MAX_STREAMS_PER_CONNECTION) {
          await Promise.allSettled([
            stream.recv.stop(0n),
            stream.send.reset(0n)
          ]);
          continue;
        }
        const controller = new AbortController();
        controllers.add(controller);
        const task = this.respond(stream, peerID, controller).catch(error => {
          logTransportFailure("request", error);
        });
        active.add(task);
        void task.finally(() => {
          active.delete(task);
          controllers.delete(controller);
        });
      }
    } finally {
      for (const controller of controllers) controller.abort();
      // Each respond() must finish its own cancellation and stream reset.
      // Never dispose the shared connection while an active stream still uses it.
      await Promise.allSettled([...active]);
      this.connections.delete(connection);
      try { await connection.close(0n, []); } catch { /* Already closed. */ }
      logTransportEvent("disconnected");
    }
  }

  async respond(stream, peerID, abort = new AbortController()) {
    this.requests.set(abort, peerID);
    const requestID = randomUUID();
    // Host shutdown, peer revocation and STOP_SENDING all abort the same
    // request owner. The Agent operation must observe each of these paths.
    const onAbort = () => {
      this.api.cancelRequest?.(requestID);
      void stream.recv.stop(0n).catch(() => {});
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
    const cancelUpstream = () => abort.abort();
    void stream.send.stopped().then(code => {
      if (code !== null && code !== undefined) cancelUpstream();
    }, cancelUpstream);
    let output = null;
    let headerStarted = false;
    let imageSlot = false;
    // Stable, privacy-safe failure stages: never log paths, peer IDs or credentials.
    let phase = "request-header";
    const progress = (pending, timeout = this.responseIdleTimeout) => withResponseProgress(
      pending, abort.signal, timeout);
    try {
      const recv = stream.recv;
      const requestLength = Buffer.from(await within(recv.readExact(4),
        REQUEST_HEADER_TIMEOUT_MS)).readUInt32BE();
      if (requestLength < 2 || requestLength > MAX_REQUEST) throw Error("Invalid request");
      phase = "request-parse";
      const input = JSON.parse(Buffer.from(await within(recv.readExact(requestLength),
        REQUEST_HEADER_TIMEOUT_MS)).toString("utf8"));
      if (!input || !["GET", "POST"].includes(input.method) ||
          typeof input.path !== "string" || !input.path.startsWith("/") ||
          input.path.length > 4096 || typeof input.body !== "string" ||
          input.body.length > 4096) throw Error("Invalid request");
      const requestPath = decodeURIComponent(new URL(input.path, "http://localhost").pathname);
      const isImage = input.method === "GET" &&
        /^\/api\/v1\/repositories\/[^/]+\/image\/?$/.test(requestPath);
      if (isImage) {
        if (this.activeImageResponses >= MAX_ACTIVE_IMAGE_RESPONSES) {
          const body = Buffer.from('{"error":"Too many active image requests"}');
          headerStarted = true;
          await progress(sendFrame(stream.send, {
            status: 429, type: "application/json", length: body.length
          }, body));
          return;
        }
        this.activeImageResponses++;
        imageSlot = true;
      }
      const payload = input.body ? Buffer.from(input.body, "base64") : undefined;
      const isPair = input.method === "POST" && requestPath === "/api/v1/pair";
      const isUpdateDownload = input.method === "GET" &&
        requestPath === "/api/v1/app/update/download";
      const upstreamDeadline = isPair ? PAIR_APPROVAL_TIMEOUT_MS
        : isUpdateDownload ? UPDATE_DOWNLOAD_HEADER_TIMEOUT_MS
        : Math.min(REQUEST_HEADER_TIMEOUT_MS, this.responseIdleTimeout);
      phase = "agent-response";
      const result = await progress(this.api.inject({
        method: input.method, url: input.path,
        headers: {
          "x-prismo-peer": peerID,
          "x-prismo-request-id": requestID,
          authorization: typeof input.authorization === "string" &&
            /^Bearer [A-Za-z0-9_-]{43}$/.test(input.authorization)
            ? input.authorization : "",
          ...(payload ? { "content-type": "application/json" } : {})
        },
        // Do not pass the transport signal to light-my-request's streamed response.
        // Its Readable may receive an unhandled AbortError before it has a consumer.
        // Peer cancellation reaches tracked Agent operations via cancelRequest(requestID).
        payload, payloadAsStream: true
      }), upstreamDeadline);
      output = result.stream();
      const length = Number(result.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE) {
        throw Error("Invalid response size");
      }
      headerStarted = true;
      phase = "send-header";
      await progress(sendHeader(stream.send, {
        status: result.statusCode,
        type: result.headers["content-type"] || "application/octet-stream",
        length
      }));
      phase = "send-body";
      let written = 0;
      const chunks = output[Symbol.asyncIterator]();
      for (;;) {
        const { value: part, done } = await progress(chunks.next());
        if (done) break;
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        written += chunk.length;
        if (written > length) throw Error("Response too large");
        for (let i = 0; i < chunk.length; i += 65536) {
          await progress(stream.send.writeAll(bytes(chunk.subarray(i, i + 65536))));
        }
      }
      if (written !== length) throw Error("Incomplete response");
      phase = "send-fin";
      await progress(stream.send.finish());
    } catch (error) {
      if (!abort.signal.aborted && this.endpoint) {
        logTransportFailure("response." + phase, error);
      }
      cancelUpstream();
      output?.destroy();
      void stream.recv.stop(0n).catch(() => {});
      try {
        if (headerStarted) {
          await within(stream.send.reset(0n), RESPONSE_CLEANUP_TIMEOUT_MS);
        } else {
          const body = Buffer.from('{"error":"요청을 완료하지 못했습니다."}');
          await within(sendFrame(stream.send, {
            status: 500, type: "application/json", length: body.length
          }, body), RESPONSE_CLEANUP_TIMEOUT_MS);
        }
      } catch {
        try {
          await within(stream.send.reset(0n), RESPONSE_CLEANUP_TIMEOUT_MS);
        } catch { /* Connection closed. */ }
      }
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      if (imageSlot) this.activeImageResponses--;
      this.requests.delete(abort);
    }
  }
}

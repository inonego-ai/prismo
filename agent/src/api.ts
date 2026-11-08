import Fastify, { type FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { requireRepository, listRepositories } from "./config.js";
import { PairingStore, deviceName } from "./pairing.js";
import { UpdateStore } from "./updates.js";
import { AccessError, getCommits, getCommitDiff, getCommitFile, getCommitFileChanges, getDiff, getStatus, readFileSnapshot, readImagePreview, TreeStore } from "./git.js";
import { GitExecutor } from "./git-executor.js";

type Params = { id: string };
type PathQuery = { path?: string };
type FileQuery = PathQuery & { revision?: "worktree" | "index" };
type TreeQuery = PathQuery & { cursor?: string };
type CommitQuery = { cursor?: string };
type DiffQuery = PathQuery & {
  scope?: "staged" | "unstaged" | "untracked"; full?: string;
};
export function createApp(pairing: PairingStore, updates: UpdateStore,
                          approvePairing: (name: string, signal: AbortSignal) => Promise<boolean>) {
  const app = Fastify({ logger: false, bodyLimit: 1024, forceCloseConnections: true });
  const trees = new TreeStore();
  const git = new GitExecutor();
  app.addHook("onClose", async () => git.close());
  const PAIR_WINDOW_MS = 60_000;
  const MAX_PAIR_ATTEMPTS = 12;
  const MAX_DOWNLOADS = 2;
  let activeDownloads = 0;
  let pairWindowStart = Date.now();
  const pairAttempts = new Map<string, number>();
  let awaitingApproval = false;
  // One operation owns the Agent handler, its response source, and its cancellation.
  // Iroh identifies it by request ID; Fastify hooks retain it through response completion.
  type Operation = {
    controller: AbortController;
    cancel: () => void;
    source: Readable | null;
  };
  const operations = new Map<string, Operation>();
  const requestOperations = new WeakMap<FastifyRequest, Operation>();

  function operationSignal(request: FastifyRequest): AbortSignal {
    const operation = requestOperations.get(request);
    if (!operation) throw Error("Request lifecycle was not initialized");
    return operation.controller.signal;
  }

  function gitRequest<T>(request: FastifyRequest, action: () => Promise<T>): Promise<T> {
    return git.runRequest(operationSignal(request), action);
  }

  app.addHook("onReady", async () => {
    await pairing.initialize();
    await updates.initialize();
  });
  app.addHook("onRequest", async (request, reply) => {
    const controller = new AbortController();
    const operation: Operation = {
      controller, source: null,
      cancel() {
        if (controller.signal.aborted) return;
        controller.abort();
        operation.source?.destroy();
        reply.raw.destroy();
      }
    };
    requestOperations.set(request, operation);
    const requestID = request.headers["x-prismo-request-id"];
    const key = typeof requestID === "string" && /^[a-f0-9-]{36}$/.test(requestID)
      ? requestID : null;
    if (key) operations.set(key, operation);
    const release = () => {
      request.raw.off("aborted", operation.cancel);
      if (key && operations.get(key) === operation) operations.delete(key);
    };
    request.raw.once("aborted", operation.cancel);
    reply.raw.once("finish", release);
    reply.raw.once("close", release);
    const path = request.routeOptions.url;
    if (path === "/health") return;
    if (path === "/api/v1/pair") {
      const peerID = request.headers["x-prismo-peer"];
      if (typeof peerID !== "string" || !/^[0-9a-f]{64}$/.test(peerID)) {
        throw new AccessError("Pairing code invalid or expired", 401);
      }
      const now = Date.now();
      if (now - pairWindowStart >= PAIR_WINDOW_MS) {
        pairWindowStart = now;
        pairAttempts.clear();
      }
      const attempts = pairAttempts.get(peerID) ?? 0;
      if (attempts >= MAX_PAIR_ATTEMPTS) throw new AccessError("Too many pairing attempts", 429);
      if (!pairAttempts.has(peerID) && pairAttempts.size >= 256) {
        pairAttempts.delete(pairAttempts.keys().next().value!);
      }
      pairAttempts.set(peerID, attempts + 1);
    }
    if (path !== "/api/v1/pair" && !pairing.authorized(request.headers.authorization,
      request.headers["x-prismo-peer"] as string | undefined)) {
      throw new AccessError("Device not paired", 401);
    }
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    const operation = requestOperations.get(request);
    if (operation && payload instanceof Readable) {
      operation.source = payload;
      if (operation.controller.signal.aborted) payload.destroy();
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    const cause = error as NodeJS.ErrnoException;
    const spawned = typeof cause.syscall === "string" && cause.syscall.startsWith("spawn ");
    const code = typeof status === "number" && Number.isInteger(status)
      && status >= 400 && status <= 599 ? status
      : cause.code === "ENOENT" && !spawned ? 404
      : (error as NodeJS.ErrnoException).code === "EISDIR" ? 400
      : 500;
    if (code >= 500) app.log.error(error);
    reply.code(code).send({
      error: code >= 500 ? "Internal server error"
        : error instanceof Error ? error.message : "Request failed"
    });
  });
  async function repoOr404(id: string) {
    const repo = await requireRepository(id);
    if (!repo) throw new AccessError("Repository not found", 404);
    return repo;
  }
  app.get("/health", async () => ({ service: "Prismo", version: 1, status: "ok" }));
  app.post<{ Body: { code?: unknown; name?: unknown; token?: unknown } }>(
    "/api/v1/pair", async request => {
      const peerID = request.headers["x-prismo-peer"] as string | undefined;
      const { code, name, token } = request.body ?? {};
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new AccessError("Invalid pairing credential", 400);
      }
      if (pairing.authorized("Bearer " + token, peerID)) return { paired: true };
      if (!pairing.matches(code, peerID)) {
        throw new AccessError("Pairing code invalid or expired", 401);
      }
      if (awaitingApproval) throw new AccessError("Registration already pending", 409);
      const approval = operationSignal(request);
      awaitingApproval = true;
      try {
        if (!await approvePairing(deviceName(name), approval)
          || approval.aborted) {
          throw new AccessError("Registration denied or cancelled", 403);
        }
        if (!await pairing.accept(code, name, peerID, token, approval)) {
          if (approval.aborted) throw new AccessError("Registration cancelled", 403);
          throw new AccessError("Pairing code invalid or expired", 401);
        }
        return { paired: true };
      } finally {
        awaitingApproval = false;
      }
    }
  );
  app.get("/api/v1/app/update", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { configured: updates.configured, update: (await updates.latest())?.info ?? null };
  });
  app.get("/api/v1/app/update/download", async (request, reply) => {
    if (activeDownloads >= MAX_DOWNLOADS) {
      throw new AccessError("Too many active downloads", 429);
    }
    activeDownloads++;
    let released = false;
    let output: import("node:stream").Readable | null = null;
    const signal = operationSignal(request);
    signal.addEventListener("abort", () => output?.destroy(), { once: true });
    const release = () => {
      if (released) return;
      released = true;
      activeDownloads--;
    };
    reply.raw.once("finish", release);
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) output?.destroy();
      if (output) {
        if (output.closed) release();
        else output.once("close", release);
      }
    });
    try {
      const published = await updates.download(signal);
      if (signal.aborted) {
        published?.stream.destroy();
        throw new AccessError("Download cancelled", 408);
      }
      if (!published) throw new AccessError("No update published", 404);
      output = published.stream;
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", "attachment; filename=\"Prismo.apk\"");
      reply.header("Content-Length", String(published.update.size));
      return reply.type("application/vnd.android.package-archive").send(output);
    } catch (error) {
      release();
      throw error;
    }
  });
  app.get("/api/v1/repositories", async () => ({
    repositories: (await listRepositories()).map(repo => ({ id: repo.id, name: repo.name }))
  }));
  app.get<{ Params: Params }>("/api/v1/repositories/:id/status", request =>
    gitRequest(request, async () => getStatus(await repoOr404(request.params.id))));
  app.get<{ Params: Params; Querystring: TreeQuery }>("/api/v1/repositories/:id/tree", async request => {
    return trees.list(await repoOr404(request.params.id), request.query.path ?? "", request.query.cursor);
  });
  app.get<{ Params: Params; Querystring: FileQuery }>("/api/v1/repositories/:id/file",
    request => gitRequest(request, async () => {
      if (!request.query.path) throw new AccessError("Path is required");
      const revision = request.query.revision ?? "worktree";
      if (revision !== "worktree" && revision !== "index") {
        throw new AccessError("Invalid file revision");
      }
      const repo = await repoOr404(request.params.id);
      const content = await readFileSnapshot(repo, request.query.path, revision);
      return { path: request.query.path, content };
    }));
  app.get<{ Params: Params; Querystring: FileQuery & { commit?: string } }>(
    "/api/v1/repositories/:id/image", (request, reply) => gitRequest(request, async () => {
      const { path, revision, commit } = request.query;
      if (!path || revision && !["worktree", "index"].includes(revision)
        || commit && revision === "index") {
        throw new AccessError("Invalid image request");
      }
      const preview = await readImagePreview(await repoOr404(request.params.id), path,
        revision ?? "worktree", commit);
      if (!preview) throw new AccessError("Image not found", 404);
      reply.header("Cache-Control", "private, no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.type(preview.contentType).send(preview.bytes);
    })
  );
  app.get<{ Params: Params; Querystring: DiffQuery }>("/api/v1/repositories/:id/diff",
    request => gitRequest(request, async () => {
      const { path, scope } = request.query;
      if (!path || !scope || !["staged", "unstaged", "untracked"].includes(scope)) {
        throw new AccessError("Valid path and scope are required");
      }
      if (request.query.full !== undefined && !["true", "false"].includes(request.query.full)) {
        throw new AccessError("Invalid diff context");
      }
      const diff = await getDiff(await repoOr404(request.params.id), path, scope,
        request.query.full === "true");
      return { path, scope, diff };
    }));
  app.get<{ Params: Params; Querystring: CommitQuery }>(
    "/api/v1/repositories/:id/commits", request =>
      gitRequest(request, async () =>
        getCommits(await repoOr404(request.params.id), request.query.cursor))
  );
  app.get<{ Params: Params & { hash: string } }>(
    "/api/v1/repositories/:id/commits/:hash/files", request => gitRequest(request, async () => {
      const changes = await getCommitFileChanges(await repoOr404(request.params.id), request.params.hash);
      return {
        files: changes.map(change => change.path),
        deletedFiles: changes.filter(change => change.deleted).map(change => change.path)
      };
    })
  );
  app.get<{ Params: Params & { hash: string }; Querystring: PathQuery }>(
    "/api/v1/repositories/:id/commits/:hash/file", request => gitRequest(request, async () => {
      if (!request.query.path) throw new AccessError("Path is required");
      const content = await getCommitFile(await repoOr404(request.params.id),
        request.params.hash, request.query.path);
      return { path: request.query.path, content };
    })
  );
  app.get<{ Params: Params & { hash: string }; Querystring: PathQuery & { full?: string } }>(
    "/api/v1/repositories/:id/commits/:hash/diff", request => gitRequest(request, async () => {
      if (!request.query.path) throw new AccessError("Path is required");
      if (request.query.full !== undefined && !["true", "false"].includes(request.query.full)) {
        throw new AccessError("Invalid diff context");
      }
      return {
        path: request.query.path,
        diff: await getCommitDiff(await repoOr404(request.params.id),
          request.params.hash, request.query.path, request.query.full === "true")
      };
    })
  );
  return Object.assign(app, {
    cancelRequest(requestID: string) {
      operations.get(requestID)?.cancel();
    }
  });
}
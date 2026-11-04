import Fastify from "fastify";
import { requireRepository, listRepositories } from "./config.js";
import { PairingStore } from "./pairing.js";
import { UpdateStore } from "./updates.js";
import { AccessError, getCommits, getCommitDiff, getCommitFile, getCommitFiles, getDiff, getStatus, readFileSnapshot, readImagePreview, TreeStore } from "./git.js";

type Params = { id: string };
type PathQuery = { path?: string };
type FileQuery = PathQuery & { revision?: "worktree" | "index" };
type TreeQuery = PathQuery & { cursor?: string };
type CommitQuery = { cursor?: string };
type DiffQuery = PathQuery & {
  scope?: "staged" | "unstaged" | "untracked"; full?: string;
};
export function createApp(pairing: PairingStore, updates: UpdateStore,
                          privateConnectionAvailable: () => Promise<boolean>) {
  const app = Fastify({ logger: false, bodyLimit: 1024, forceCloseConnections: true });
  const trees = new TreeStore();
  const PAIR_WINDOW_MS = 60_000;
  const MAX_PAIR_ATTEMPTS = 12;
  const MAX_DOWNLOADS = 2;
  let activeDownloads = 0;
  let pairWindowStart = Date.now();
  let pairAttempts = 0;
  app.addHook("onReady", async () => {
    await pairing.initialize();
    await updates.initialize();
  });
  app.addHook("onRequest", async request => {
    const path = request.routeOptions.url;
    if (path === "/health") return;
    if (path === "/api/v1/pair") {
      const now = Date.now();
      if (now - pairWindowStart >= PAIR_WINDOW_MS) {
        pairWindowStart = now;
        pairAttempts = 0;
      }
      if (pairAttempts >= MAX_PAIR_ATTEMPTS) throw new AccessError("Too many pairing attempts", 429);
      pairAttempts++;
    }
    if (path !== "/api/v1/pair" && !pairing.authorized(request.headers.authorization)) {
      throw new AccessError("Device not paired", 401);
    }
    if (!(await privateConnectionAvailable())) {
      throw new AccessError("Private Tailscale connection unavailable", 503);
    }
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
  app.post<{ Body: { code?: unknown } }>("/api/v1/pair", async request => {
    const token = await pairing.accept(request.body?.code);
    if (!token) throw new AccessError("Pairing code invalid or expired", 401);
    return { token };
  });
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
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      output?.destroy();
    };
    const release = () => {
      if (released) return;
      released = true;
      activeDownloads--;
    };
    request.raw.once("aborted", abort);
    reply.raw.once("finish", release);
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) abort();
      if (output) {
        if (output.closed) release();
        else output.once("close", release);
      }
    });
    try {
      const published = await updates.download(controller.signal);
      if (controller.signal.aborted) {
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
  app.get<{ Params: Params }>("/api/v1/repositories/:id/status", async request => {
    return getStatus(await repoOr404(request.params.id));
  });
  app.get<{ Params: Params; Querystring: TreeQuery }>("/api/v1/repositories/:id/tree", async request => {
    return trees.list(await repoOr404(request.params.id), request.query.path ?? "", request.query.cursor);
  });
  app.get<{ Params: Params; Querystring: FileQuery }>("/api/v1/repositories/:id/file", async request => {
    if (!request.query.path) throw new AccessError("Path is required");
    const revision = request.query.revision ?? "worktree";
    if (revision !== "worktree" && revision !== "index") {
      throw new AccessError("Invalid file revision");
    }
    const repo = await repoOr404(request.params.id);
    const content = await readFileSnapshot(repo, request.query.path, revision);
    return { path: request.query.path, content };
  });
  app.get<{ Params: Params; Querystring: FileQuery & { commit?: string } }>(
    "/api/v1/repositories/:id/image", async (request, reply) => {
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
    }
  );
  app.get<{ Params: Params; Querystring: DiffQuery }>("/api/v1/repositories/:id/diff", async request => {
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
  });
  app.get<{ Params: Params; Querystring: CommitQuery }>(
    "/api/v1/repositories/:id/commits", async request => {
      return getCommits(await repoOr404(request.params.id), request.query.cursor);
    }
  );
  app.get<{ Params: Params & { hash: string } }>(
    "/api/v1/repositories/:id/commits/:hash/files", async request => {
      return { files: await getCommitFiles(await repoOr404(request.params.id), request.params.hash) };
    }
  );
  app.get<{ Params: Params & { hash: string }; Querystring: PathQuery }>(
    "/api/v1/repositories/:id/commits/:hash/file", async request => {
      if (!request.query.path) throw new AccessError("Path is required");
      const content = await getCommitFile(await repoOr404(request.params.id),
        request.params.hash, request.query.path);
      return { path: request.query.path, content };
    }
  );
  app.get<{ Params: Params & { hash: string }; Querystring: PathQuery & { full?: string } }>(
    "/api/v1/repositories/:id/commits/:hash/diff", async request => {
      if (!request.query.path) throw new AccessError("Path is required");
      if (request.query.full !== undefined && !["true", "false"].includes(request.query.full)) {
        throw new AccessError("Invalid diff context");
      }
      return {
        path: request.query.path,
        diff: await getCommitDiff(await repoOr404(request.params.id),
          request.params.hash, request.query.path, request.query.full === "true")
      };
    }
  );
  return app;
}
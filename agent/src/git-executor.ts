import { AsyncLocalStorage } from "node:async_hooks";

export const GIT_PARALLELISM = 4;
const MAX_PENDING_GIT = 32;
type GitRequest = { executor: GitExecutor; signal: AbortSignal };
type WaitingGit = { grant: () => void; cancel: () => void };
const gitRequest = new AsyncLocalStorage<GitRequest>();

class GitBusyError extends Error {
  readonly statusCode = 429;
  constructor() { super("Git service is busy"); }
}

/** Owns a Git operation's execution slots, queued work, and abort lifetime. */
export class GitExecutor {
  private active = 0;
  private readonly waiting: WaitingGit[] = [];
  private readonly shutdown = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();

  runRequest<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    return gitRequest.run({ executor: this, signal }, action);
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.waiting.length && this.active < GIT_PARALLELISM) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_PENDING_GIT) {
      return Promise.reject(new GitBusyError());
    }
    return new Promise<void>((resolve, reject) => {
      const entry: WaitingGit = {
        grant: () => {
          signal.removeEventListener("abort", entry.cancel);
          resolve();
        },
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(signal.reason);
        }
      };
      this.waiting.push(entry);
      signal.addEventListener("abort", entry.cancel, { once: true });
      if (signal.aborted) entry.cancel();
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.active--;
  }

  async execute<T>(action: (signal: AbortSignal) => Promise<T>,
                   requestSignal?: AbortSignal): Promise<T> {
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.shutdown.signal])
      : this.shutdown.signal;
    const running = (async () => {
      await this.acquire(signal);
      try {
        signal.throwIfAborted();
        return await action(signal);
      } finally {
        this.release();
      }
    })();
    this.operations.add(running);
    try { return await running; }
    finally { this.operations.delete(running); }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.operations]);
  }
}

// Standalone tooling and repository registration share a process-local budget;
// API requests use the owning Agent instance via runRequest().
const standaloneGit = new GitExecutor();

export function executeGit<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const request = gitRequest.getStore();
  return (request?.executor ?? standaloneGit).execute(action, request?.signal);
}

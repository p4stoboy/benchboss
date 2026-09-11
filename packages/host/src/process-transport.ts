import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface ProcessLimits {
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
  maxResidentBytes?: number;
  maxMessageBytes?: number;
  maxQueued?: number;
}
export interface ProcessTransport {
  request<T>(payload: unknown): Promise<T>;
  close(): Promise<void>;
  failed(): boolean;
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw Error("invalid resource limit");
  return limit;
}

export function createProcessTransport(options: ProcessLimits): ProcessTransport {
  const timeoutMs = positiveLimit(options.timeoutMs, 2000);
  const maxResidentBytes = positiveLimit(options.maxResidentBytes, 256 * 1024 * 1024);
  const maxMessageBytes = positiveLimit(options.maxMessageBytes, 8 * 1024 * 1024);
  const maxQueued = positiveLimit(options.maxQueued, 64);
  const [executable, ...args] = options.command;
  if (!executable) throw Error("missing worker command");
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { LANG: "C", TZ: "UTC", ...options.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  let failure: Error | undefined;
  let sequence = 0;
  let queued = 0;
  let buffer = "";
  let stderrBytes = 0;
  let checkingMemory = false;
  let tail: Promise<unknown> = Promise.resolve();
  let current:
    | {
        id: number;
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const fail = (reason: string) => {
    failure ??= Object.assign(Error(reason), { kind: "worker_failure", reason });
    if (current) {
      clearTimeout(current.timer);
      current.reject(failure);
      current = undefined;
    }
    child.kill("SIGKILL");
  };
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      clearInterval(memoryCheck);
      if (current) fail("worker_exited");
      resolve();
    });
  });
  child.once("error", () => fail("worker_start_failed"));
  child.stdin.on("error", () => fail("worker_pipe_failed"));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxMessageBytes) return fail("worker_output_limit");
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as { id?: unknown; ok?: unknown; value?: unknown };
        if (!message || !current || message.id !== current.id || typeof message.ok !== "boolean")
          return fail("worker_protocol_error");
        const pending = current;
        current = undefined;
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else {
          pending.reject(Object.assign(Error("worker_command_failed"), { kind: "worker_failure" }));
          fail("worker_command_failed");
        }
      } catch {
        return fail("worker_protocol_error");
      }
      end = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxMessageBytes) fail("worker_output_limit");
  });
  const memoryCheck = setInterval(() => {
    if (closed || checkingMemory || !child.pid) return;
    checkingMemory = true;
    const checked = (error: unknown, resident: number) => {
      checkingMemory = false;
      if (closed) return;
      if (error) return fail("worker_memory_check_failed");
      if (!Number.isFinite(resident) || resident > maxResidentBytes) fail("worker_memory_limit");
    };
    if (process.platform === "linux") {
      void readFile(`/proc/${child.pid}/status`, "utf8").then(
        (status) => checked(null, Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]) * 1024),
        (error) => checked(error, 0),
      );
    } else
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { timeout: 1000 },
        (error, output) => checked(error, Number(output.trim()) * 1024),
      );
  }, 100);
  memoryCheck.unref();
  return {
    failed: () => closed || failure !== undefined,
    request<T>(payload: unknown): Promise<T> {
      if (queued >= maxQueued) return Promise.reject(Error("worker_queue_full"));
      queued++;
      const response = tail
        .catch(() => undefined)
        .then(() => {
          if (failure || closed) throw failure ?? Error("worker_closed");
          const id = ++sequence;
          const wire = `${JSON.stringify({ id, payload })}\n`;
          if (Buffer.byteLength(wire) > maxMessageBytes) throw Error("worker_input_limit");
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => fail("worker_timeout"), timeoutMs);
            current = { id, resolve, reject, timer };
            child.stdin.write(wire);
          });
        });
      tail = response;
      return response.finally(() => {
        queued--;
      }) as Promise<T>;
    },
    async close() {
      if (!closed) {
        fail("worker_closed");
        clearInterval(memoryCheck);
        await exited;
      }
    },
  };
}

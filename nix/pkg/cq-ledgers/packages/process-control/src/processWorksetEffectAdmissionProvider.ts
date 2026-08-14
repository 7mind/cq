import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  WorksetBrokerAdmissionHandle,
  WorksetBrokerProcessGroupRegistration,
  WorksetEffectAdmissionProvider,
} from "./worksetEffectProtocol.ts";

export interface ProcessWorksetEffectAdmissionProviderOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type ProviderRequest =
  | {
      readonly op: "acquire";
      readonly kind: WorksetBrokerAdmissionHandle["kind"];
      readonly targetRef: string;
    }
  | ({ readonly op: "register" | "share" } & WorksetBrokerProcessGroupRegistration)
  | { readonly op: "settle" | "release" | "abandon" };

interface PendingResponse {
  readonly expectedKeys: readonly string[];
  readonly resolve: (value: Readonly<Record<string, unknown>>) => void;
  readonly reject: (error: Error) => void;
}

const PROCESS_PROVIDER_HANDLE_ID = "process-workset-effect-admission";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredNonEmpty(value: string, name: string): string {
  if (value.trim() === "") {
    throw new Error(`@cq/process-control: process workset provider ${name} must be non-empty`);
  }
  return value;
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const observed = Object.keys(record).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

class ProcessWorksetProviderSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: PendingResponse[] = [];
  private terminal = false;
  private exitError: Error | null = null;
  private readonly exited: Promise<void>;

  constructor(options: ProcessWorksetEffectAdmissionProviderOptions) {
    const command = requiredNonEmpty(options.command, "command");
    this.child = spawn(command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    this.exited = new Promise<void>((resolve, reject) => {
      this.child.once("error", (error) => {
        const wrapped = new Error(
          `@cq/process-control: process workset provider failed to start: ${errorMessage(error)}`,
        );
        this.fail(wrapped);
        reject(wrapped);
      });
      this.child.once("exit", (code, signal) => {
        if (code === 0 && this.terminal && this.pending.length === 0) {
          resolve();
          return;
        }
        const wrapped = new Error(
          `@cq/process-control: process workset provider exited ` +
            `${code === null ? `for signal ${String(signal)}` : String(code)}`,
        );
        this.fail(wrapped);
        reject(wrapped);
      });
    });
    void this.exited.catch(() => undefined);
  }

  private fail(error: Error): void {
    if (this.exitError === null) this.exitError = error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  private receive(line: string): void {
    const pending = this.pending.shift();
    if (pending === undefined) {
      this.child.kill("SIGTERM");
      this.fail(new Error("@cq/process-control: unsolicited process workset provider response"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      pending.reject(new Error("@cq/process-control: malformed process workset provider response"));
      this.child.kill("SIGTERM");
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      pending.reject(new Error("@cq/process-control: malformed process workset provider response"));
      this.child.kill("SIGTERM");
      return;
    }
    const response = value as Readonly<Record<string, unknown>>;
    if (response["ok"] !== true) {
      const errorKeys = response["closed"] === true
        ? ["closed", "error", "ok"]
        : ["error", "ok"];
      if (response["ok"] !== false || !hasExactKeys(response, errorKeys)) {
        pending.reject(new Error("@cq/process-control: malformed process workset provider error"));
        this.child.kill("SIGTERM");
        return;
      }
      const message = response["error"];
      if (response["closed"] === true) {
        this.terminal = true;
        this.child.stdin.end();
      }
      pending.reject(
        new Error(
          `@cq/process-control: process workset provider rejected operation` +
            `${typeof message === "string" && message !== "" ? `: ${message}` : ""}`,
        ),
      );
      return;
    }
    if (!hasExactKeys(response, pending.expectedKeys)) {
      pending.reject(new Error("@cq/process-control: surplus process workset provider response data"));
      this.child.kill("SIGTERM");
      return;
    }
    pending.resolve(response);
  }

  async request(request: ProviderRequest, terminal = false): Promise<Readonly<Record<string, unknown>>> {
    if (this.exitError !== null) throw this.exitError;
    if (this.terminal) {
      throw new Error("@cq/process-control: process workset provider session is already closed");
    }
    const response = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      this.pending.push({
        expectedKeys: request.op === "acquire" ? ["epoch", "ok"] : ["ok"],
        resolve,
        reject,
      });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.fail(
            new Error(
              `@cq/process-control: process workset provider request failed: ${errorMessage(error)}`,
            ),
          );
        }
      });
    });
    const value = await response;
    if (terminal) {
      this.terminal = true;
      this.child.stdin.end();
      await this.exited;
    }
    return value;
  }
}

/**
 * Process-local proxy for the durable workset admission retained by a trusted
 * provider-control sidecar. Only stage messages cross its private stdio; the
 * backend admission handle never leaves the sidecar process.
 */
export function createProcessWorksetEffectAdmissionProvider(
  options: ProcessWorksetEffectAdmissionProviderOptions,
): WorksetEffectAdmissionProvider {
  return {
    acquire: async (input) => {
      const session = new ProcessWorksetProviderSession(options);
      const response = await session.request({
        op: "acquire",
        kind: input.kind,
        targetRef: input.targetRef,
      });
      const epoch = response["epoch"];
      if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) {
        await session.request({ op: "abandon" }, true).catch(() => undefined);
        throw new Error("@cq/process-control: process workset provider returned an invalid epoch");
      }
      return {
        id: PROCESS_PROVIDER_HANDLE_ID,
        epoch: epoch as number,
        kind: input.kind,
        targetRef: input.targetRef,
        registerProcessGroup: async (registration) => {
          await session.request({ op: "register", ...registration });
        },
        shareWithGuardian: async (registration) => {
          await session.request({ op: "share", ...registration });
        },
        markSettled: async () => {
          await session.request({ op: "settle" });
        },
        releaseAfterSettlement: async () => {
          await session.request({ op: "release" }, true);
        },
        abandonBeforeRegistration: async () => {
          await session.request({ op: "abandon" }, true);
        },
      } satisfies WorksetBrokerAdmissionHandle;
    },
  };
}

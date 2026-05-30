export type Args = Readonly<{
  cwd: string;
  host: string;
  port: number;
  db: string;
  dev: boolean;
  shutdownTimeoutMs: number;
}>;

/**
 * Options for the `cq reset` subcommand. `backup` defaults to true (the
 * regenerable bootstrap ledger files are MOVED to a timestamped backup dir
 * rather than hard-deleted); `--no-backup` flips it to a hard delete. `yes`
 * skips the interactive confirmation prompt (for non-interactive use).
 */
export type ResetOpts = Readonly<{
  cwd: string;
  yes: boolean;
  backup: boolean;
}>;

/**
 * Discriminated invocation: either start the server (`kind: "server"`,
 * carrying the parsed server `Args`) or run the reset subcommand
 * (`kind: "reset"`, carrying `ResetOpts`). The first positional arg `reset`
 * selects the reset path; anything else preserves today's behaviour exactly
 * (delegates to `parseArgs`).
 */
export type Invocation =
  | Readonly<{ kind: "server"; args: Args }>
  | Readonly<{ kind: "reset"; opts: ResetOpts }>;

const USAGE = `\
Usage: cq [options]
       cq reset [options]

Options (server):
  --cwd <path>                  Working directory (default: process.cwd())
  --host <host>                 Bind host (default: 127.0.0.1)
  --port <port>                 Bind port, integer (default: 5173)
  --db <path>                   SQLite database path (default: ./var/db/cq.sqlite)
  --dev                         Enable HMR dev server (default: false)
  --shutdown-timeout-ms <ms>    Graceful shutdown timeout in ms (default: 5000)
  --help                        Print this message and exit

reset — back up and clear the regenerable bootstrapped ledger files
        (docs/ledgers.yaml, docs/<ledger>.md, docs/.locks/, and any
        docs/archive/<ledger>/) so the next start regenerates them:
  --cwd <path>                  Working directory (default: process.cwd())
  --yes                         Skip the confirmation prompt (non-interactive)
  --no-backup                   Hard-delete instead of moving to a backup dir
`;

const RESET_USAGE = `\
Usage: cq reset [options]

Options:
  --cwd <path>                  Working directory (default: process.cwd())
  --yes                         Skip the confirmation prompt (non-interactive)
  --no-backup                   Hard-delete instead of moving to a backup dir
  --help                        Print this message and exit
`;

export function parseArgs(argv: string[]): Args {
  let cwd: string = process.cwd();
  let host: string = "127.0.0.1";
  let port: number = 5173;
  let db: string = "./var/db/cq.sqlite";
  let dev: boolean = false;
  let shutdownTimeoutMs: number = 5000;

  const args = argv.slice();
  while (args.length > 0) {
    const flag = args.shift()!;

    if (flag === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    if (flag === "--dev") {
      dev = true;
      continue;
    }

    if (
      flag === "--cwd" ||
      flag === "--host" ||
      flag === "--port" ||
      flag === "--db" ||
      flag === "--shutdown-timeout-ms"
    ) {
      const value = args.shift();
      if (value === undefined) {
        process.stderr.write(`Error: flag ${flag} requires a value\n${USAGE}`);
        process.exit(1);
      }
      if (flag === "--cwd") {
        cwd = value;
      } else if (flag === "--host") {
        host = value;
      } else if (flag === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          process.stderr.write(
            `Error: --port must be a positive integer (1–65535), got: ${value}\n${USAGE}`,
          );
          process.exit(1);
        }
        port = parsed;
      } else if (flag === "--shutdown-timeout-ms") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          process.stderr.write(
            `Error: --shutdown-timeout-ms must be a positive integer, got: ${value}\n${USAGE}`,
          );
          process.exit(1);
        }
        shutdownTimeoutMs = parsed;
      } else {
        db = value;
      }
    } else {
      process.stderr.write(`Error: unknown flag: ${flag}\n${USAGE}`);
      process.exit(1);
    }
  }

  return Object.freeze({ cwd, host, port, db, dev, shutdownTimeoutMs });
}

/**
 * Parse the `cq reset` subcommand flags. `argv` is the args AFTER the leading
 * `reset` positional. Unknown flags / missing values exit non-zero with the
 * reset usage (same fail-fast discipline as `parseArgs`).
 */
function parseResetOpts(argv: string[]): ResetOpts {
  let cwd: string = process.cwd();
  let yes: boolean = false;
  let backup: boolean = true;

  const args = argv.slice();
  while (args.length > 0) {
    const flag = args.shift()!;

    if (flag === "--help") {
      process.stdout.write(RESET_USAGE);
      process.exit(0);
    }

    if (flag === "--yes") {
      yes = true;
      continue;
    }

    if (flag === "--no-backup") {
      backup = false;
      continue;
    }

    if (flag === "--cwd") {
      const value = args.shift();
      if (value === undefined) {
        process.stderr.write(
          `Error: flag ${flag} requires a value\n${RESET_USAGE}`,
        );
        process.exit(1);
      }
      cwd = value;
      continue;
    }

    process.stderr.write(`Error: unknown reset flag: ${flag}\n${RESET_USAGE}`);
    process.exit(1);
  }

  return Object.freeze({ cwd, yes, backup });
}

/**
 * Top-level dispatch over `process.argv.slice(2)`. If the first positional is
 * `reset`, parse the reset subcommand; otherwise preserve today's behaviour
 * exactly by delegating to `parseArgs` (server / dev-server start). The
 * `reset` keyword is only recognised as the FIRST token — a leading flag
 * (e.g. `--cwd`) always routes to the server, so no existing invocation
 * changes meaning.
 */
export function parseInvocation(argv: string[]): Invocation {
  if (argv.length > 0 && argv[0] === "reset") {
    return Object.freeze({
      kind: "reset",
      opts: parseResetOpts(argv.slice(1)),
    });
  }
  return Object.freeze({ kind: "server", args: parseArgs(argv) });
}

export type Args = Readonly<{
  cwd: string;
  host: string;
  port: number;
  db: string;
  dev: boolean;
}>;

const USAGE = `\
Usage: cq [options]

Options:
  --cwd <path>   Working directory (default: process.cwd())
  --host <host>  Bind host (default: 127.0.0.1)
  --port <port>  Bind port, integer (default: 5173)
  --db <path>    SQLite database path (default: ./var/db/cq.sqlite)
  --dev          Enable HMR dev server (default: false)
  --help         Print this message and exit
`;

export function parseArgs(argv: string[]): Args {
  let cwd: string = process.cwd();
  let host: string = "127.0.0.1";
  let port: number = 5173;
  let db: string = "./var/db/cq.sqlite";
  let dev: boolean = false;

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
      flag === "--db"
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
      } else {
        db = value;
      }
    } else {
      process.stderr.write(`Error: unknown flag: ${flag}\n${USAGE}`);
      process.exit(1);
    }
  }

  return Object.freeze({ cwd, host, port, db, dev });
}

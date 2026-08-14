/** `cq config` — emit the canonical get_config(all) payload. */

export const EXIT_CONFIG = 0;
export const EXIT_CONFIG_ERROR = 1;

export interface ConfigArgs {
  readonly cwd: string;
}

export interface ConfigIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ConfigOutcome {
  readonly exitCode: number;
}

export async function runConfig(args: ConfigArgs, io: ConfigIo): Promise<ConfigOutcome> {
  try {
    const { computeConfig } = await import("@cq/ledger-mcp");
    io.out(JSON.stringify(computeConfig(args.cwd)));
    return { exitCode: EXIT_CONFIG };
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: EXIT_CONFIG_ERROR };
  }
}

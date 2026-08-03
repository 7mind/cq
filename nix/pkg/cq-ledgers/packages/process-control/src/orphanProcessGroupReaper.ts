import {
  readProcessIdentityWithDarwinHelper,
  signalProcessGroup,
  type ProcessIdentity,
} from "./processGroup.js";
import { REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS } from "./registeredLaunchProtocol.js";

const REAPER_POLL_MS = Math.min(25, REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS);

async function main(argv: readonly string[]): Promise<void> {
  const bootstrapPidText = argv[0];
  const bootstrapStartTime = argv[1];
  const launcherDarwinHelperText = argv[2];
  const settlementDeadlineText = argv[3];
  if (
    bootstrapPidText === undefined ||
    bootstrapPidText === "" ||
    bootstrapStartTime === undefined ||
    bootstrapStartTime === "" ||
    launcherDarwinHelperText === undefined ||
    settlementDeadlineText === undefined ||
    settlementDeadlineText === ""
  ) {
    throw new Error("cq registered-launch orphan reaper: incomplete launch arguments");
  }

  const bootstrap: ProcessIdentity = {
    pid: Number(bootstrapPidText),
    startTime: bootstrapStartTime,
  };
  const launcherDarwinHelper = launcherDarwinHelperText === "" ? null : launcherDarwinHelperText;
  const settlementDeadline = Number(settlementDeadlineText);
  if (!Number.isSafeInteger(settlementDeadline) || settlementDeadline <= 0) {
    throw new Error("cq registered-launch orphan reaper: invalid settlement deadline");
  }
  for (;;) {
    const observed = await readProcessIdentityWithDarwinHelper(
      bootstrap.pid,
      launcherDarwinHelper,
    );
    if (
      observed === null ||
      observed.startTime !== bootstrap.startTime ||
      Date.now() >= settlementDeadline
    ) {
      signalProcessGroup(bootstrap.pid, "SIGKILL");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, REAPER_POLL_MS));
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.exitCode = 1;
  if (!process.stderr.writableEnded) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
});

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  WorksetEffectBroker,
  createProcessWorksetEffectAdmissionProvider,
  type RegisteredLaunchBootstrapSpecification,
} from "@cq/process-control";

const [root, cli, marker] = process.argv.slice(2);
if (root === undefined || cli === undefined || marker === undefined) {
  throw new Error("workset effect parent fixture requires root, cli, and marker");
}

function childExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

function bootstrap(specification: RegisteredLaunchBootstrapSpecification<StdioOptions>) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: childExited(child),
    outputDrained: Promise.resolve(),
    resultFromTargetOutcome: (outcome: { readonly exitCode: number | null }) =>
      outcome.exitCode ?? 0,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

const target = [
  "const {spawn}=require('node:child_process');",
  "const fs=require('node:fs');",
  "const descendant=spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
  `fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({targetPid:process.pid,descendantPid:descendant.pid})+'\\n');`,
  "process.on('SIGTERM',()=>{});",
  "setInterval(()=>{},1000);",
].join("");

const provider = createProcessWorksetEffectAdmissionProvider({
  command: process.execPath,
  args: ["run", cli, "__workset-effect-provider", "--cwd", root],
  cwd: root,
  env: process.env,
});
const launched = await new WorksetEffectBroker({ provider }).launch({
  kind: "child-dispatch",
  targetRef: "tasks:T1983",
  argv: [process.execPath, "-e", target],
  cwd: root,
  env: process.env,
  stdio: "ignore" as StdioOptions,
  launchBootstrap: bootstrap,
});
await launched.exited;

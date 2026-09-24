/** G224 / K331: record the Claude print argv, then exit without a terminal result. */
import { writeFileSync } from "node:fs";

const capturePath = process.env["CQ_CLAUDE_ARGV_CAPTURE"];
if (capturePath === undefined) throw new Error("CQ_CLAUDE_ARGV_CAPTURE is required");
writeFileSync(capturePath, JSON.stringify(process.argv.slice(2)));
process.exit(1);

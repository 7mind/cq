/**
 * G224: a stand-in for `pi -p --mode json`. It records its argv (including the
 * task) and emits the event stream a real Pi child prints, ending with an
 * assistant message whose fenced json block is the role result.
 */

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const capture = process.env["CQ_FAKE_PI_ARGV_CAPTURE"];
if (capture !== undefined) writeFileSync(capture, JSON.stringify(argv));
const output = process.env["CQ_FAKE_PI_OUTPUT"] ?? "{}";
const events = [
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: argv.at(-1) }] } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working." }] } },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: `Result:\n\`\`\`json\n${output}\n\`\`\`` }] },
  },
];
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

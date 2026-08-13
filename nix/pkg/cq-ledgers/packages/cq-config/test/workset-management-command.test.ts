import { describe, expect, test } from "bun:test";
import {
  WORKSET_CREDENTIAL_ENV_NAMES,
  createWorksetManagementCommand,
  withoutWorksetCredentials,
} from "../src/index.js";

describe("workset management command boundaries", () => {
  test("keeps credentials out of argv and dispatched child environments", () => {
    const environment = {
      CQ_SERVE_TOKEN: "ordinary-secret",
      CQ_SERVE_MANAGEMENT_TOKEN: "management-secret",
      CQ_LEDGER_REMOTE_TOKEN: "remote-secret",
      SAFE_VALUE: "retained",
    };
    const command = createWorksetManagementCommand({
      command: "cq",
      args: ["mcp", "--cwd", "/repo"],
      environment,
    });

    expect(command.args).toEqual(["mcp", "--cwd", "/repo"]);
    expect(command.args.join("\n")).not.toContain("secret");
    expect(command.env["SAFE_VALUE"]).toBe("retained");
    for (const name of WORKSET_CREDENTIAL_ENV_NAMES) {
      expect(command.env[name]).toBeUndefined();
    }
    expect(environment.CQ_SERVE_MANAGEMENT_TOKEN).toBe("management-secret");
  });

  test("scrubs a copied environment without mutating the host input", () => {
    const host = { CQ_SERVE_MANAGEMENT_TOKEN: "secret", KEEP: "yes" };
    const child = withoutWorksetCredentials(host);

    expect(child).toEqual({ KEEP: "yes" });
    expect(host.CQ_SERVE_MANAGEMENT_TOKEN).toBe("secret");
  });
});

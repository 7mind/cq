/**
 * T723 specified-origin contract tests.
 *
 * Constructive taxonomy: Behavioral-Active Blackbox-Atomic. These tests use
 * only @cq/config's public parse and environment-resolution interfaces.
 */

import { describe, expect, it } from "bun:test";
import {
  CQ_LEDGER_REMOTE_TOKEN_ENV,
  CqConfigError,
  LEDGER_BACKENDS,
  RemoteLedgerTokenError,
  parseConfig,
  resolveRemoteLedgerToken,
} from "../src/index.js";

const VALID_REMOTE_TOML = `
[ledger]
backend = "remote"
serverUrl = "https://ledger.example.test/base"
projectId = "acme-widgets"

[project]
name = "Acme Widgets"
`;

describe("remote ledger config contract (T723)", () => {
  it("parses required serverUrl and preserves the existing identity chain inputs", () => {
    const config = parseConfig(VALID_REMOTE_TOML);

    expect(config.ledger?.backend).toBe("remote");
    expect(config.ledger?.backendExplicit).toBe(true);
    expect(config.ledger?.branch).toBe("cq-ledger");
    expect(config.ledger?.remote).toBe("origin");
    expect(config.ledger?.backup).toBe("none");
    expect(config.ledger?.projectId).toBe("acme-widgets");
    expect(config.ledger?.url).toBeNull();
    expect(config.ledger?.serverUrl as string).toBe(
      "https://ledger.example.test/base",
    );
    expect(config.project).toEqual({ name: "Acme Widgets" });
  });

  it.each([
    "http://ledger.example.test",
    "https://ledger.example.test",
  ])("accepts an HTTP(S) serverUrl: %s", (serverUrl) => {
    const config = parseConfig(`
[ledger]
backend = "remote"
serverUrl = "${serverUrl}"
`);

    expect(config.ledger?.serverUrl as string).toBe(serverUrl);
  });

  it("rejects a missing serverUrl with an actionable error", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
`),
    ).toThrow(
      new CqConfigError(
        '[ledger] backend "remote" requires a non-secret serverUrl using http:// or https://',
      ),
    );
  });

  it.each([
    ["empty", ""],
    ["malformed", "not a URL"],
    ["missing host", "https://"],
    ["surrounded by whitespace", " https://ledger.example.test "],
  ])("rejects an invalid %s serverUrl", (_case, serverUrl) => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "${serverUrl}"
`),
    ).toThrow(/\[ledger\] serverUrl .*valid absolute HTTP\(S\) URL/);
  });

  it("rejects an HTTP scheme without authority delimiters", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "https:ledger.example.test"
`),
    ).toThrow(/\[ledger\] serverUrl must use http:\/\/ or https:\/\//);
  });

  it("rejects a non-string serverUrl", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = 42
`),
    ).toThrow(/\[ledger\] serverUrl must be a string/);
  });

  it("rejects serverUrl on a non-remote backend instead of ignoring it", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "xdg"
serverUrl = "https://ledger.example.test"
`),
    ).toThrow(/\[ledger\] serverUrl is only valid when backend = "remote"/);
  });

  it.each([
    "ftp://ledger.example.test",
    "file:///tmp/cq",
    "ws://ledger.example.test",
  ])("rejects non-HTTP(S) serverUrl %s", (serverUrl) => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "${serverUrl}"
`),
    ).toThrow(/\[ledger\] serverUrl must use http:\/\/ or https:\/\//);
  });

  it.each([
    "https://user@ledger.example.test",
    "https://user:password@ledger.example.test",
  ])("rejects credential-bearing serverUrl %s", (serverUrl) => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "${serverUrl}"
`),
    ).toThrow(
      /\[ledger\] serverUrl must not contain credentials; use CQ_LEDGER_REMOTE_TOKEN/,
    );
  });

  it.each([
    ["query", "https://ledger.example.test?tenant=acme"],
    ["query", "https://ledger.example.test?"],
    ["fragment", "https://ledger.example.test#tenant"],
    ["fragment", "https://ledger.example.test#"],
  ])("rejects a %s-bearing serverUrl", (_case, serverUrl) => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "${serverUrl}"
`),
    ).toThrow(
      new RegExp(`\\[ledger\\] serverUrl must not contain a ${_case}`),
    );
  });

  it("rejects an attempted bearer token in cq.toml", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "remote"
serverUrl = "https://ledger.example.test"
token = "must-not-be-committed"
`),
    ).toThrow(/unexpected key "token" in \[ledger\]/);
  });

  it("resolves the ordinary bearer token only from CQ_LEDGER_REMOTE_TOKEN", () => {
    const token = resolveRemoteLedgerToken({
      [CQ_LEDGER_REMOTE_TOKEN_ENV]: "environment-only-secret",
    });

    expect(token as string).toBe("environment-only-secret");
    expect(JSON.stringify(parseConfig(VALID_REMOTE_TOML))).not.toContain(
      "environment-only-secret",
    );
  });

  it.each([
    {},
    { CQ_LEDGER_REMOTE_TOKEN: "" },
    { CQ_LEDGER_REMOTE_TOKEN: "   " },
  ])(
    "rejects a missing or empty CQ_LEDGER_REMOTE_TOKEN",
    (env) => {
      expect(() => resolveRemoteLedgerToken(env)).toThrow(
        new RemoteLedgerTokenError(
          "CQ_LEDGER_REMOTE_TOKEN must be set to a non-empty bearer token for the remote ledger backend",
        ),
      );
    },
  );

  it("keeps postgres parseable alongside remote; T736 is the sole removal owner", () => {
    expect(LEDGER_BACKENDS).toContain("remote");
    expect(LEDGER_BACKENDS).toContain("postgres");
    expect(
      parseConfig(`
[ledger]
backend = "postgres"
url = "postgres://db.example.test:5432/cq"
`).ledger,
    ).toMatchObject({
      backend: "postgres",
      url: "postgres://db.example.test:5432/cq",
      serverUrl: null,
    });
  });

  it("preserves the xdg default while remote remains opt-in", () => {
    expect(parseConfig("").ledger).toBeNull();
    expect(parseConfig("[ledger]\n").ledger).toMatchObject({
      backend: "xdg",
      backendExplicit: false,
      serverUrl: null,
    });
  });
});

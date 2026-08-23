import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  computeManagedGateScriptDagSha256,
  resolveManagedGateClosure,
  type ManagedGateClosureManifestV1,
  type ManagedGateOpaqueEdgeDeclaration,
} from "../src/index.js";

const roots: string[] = [];
const TARGET_PACKAGE = "nix/pkg/cq-ledgers/package.json";
const TARGET_ROOT = path.dirname(TARGET_PACKAGE);

interface ClosureFixture {
  readonly root: string;
  readonly targetRoot: string;
  readonly scripts: Readonly<Record<string, string>>;
}

async function createFixture(
  scripts: Readonly<Record<string, string>> = {
    check: "tsc -b && bun run lint && bun test",
    lint: "eslint .",
  },
): Promise<ClosureFixture> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2290-gate-closure-"));
  roots.push(root);
  const targetRoot = path.join(root, TARGET_ROOT);
  await fs.mkdir(path.join(targetRoot, "test"), { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, "package.json"),
    `${JSON.stringify({ name: "target", private: true, scripts }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(targetRoot, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(targetRoot, "test", "gate.test.ts"), "export const gate = true;\n");
  return { root, targetRoot, scripts };
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeManifest(
  fixture: ClosureFixture,
  opaqueEdges: readonly ManagedGateOpaqueEdgeDeclaration[] = [],
): Promise<void> {
  const manifest: ManagedGateClosureManifestV1 = {
    version: 1,
    target: {
      packageJson: TARGET_PACKAGE,
      script: "check",
      scriptDagSha256: computeManagedGateScriptDagSha256(fixture.scripts, "check"),
    },
    opaqueEdges,
  };
  await fs.writeFile(
    path.join(fixture.root, "cq-gate-closure.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function addBunRoot(
  fixture: ClosureFixture,
  relativeRoot: string,
  source = "index.ts",
): Promise<string> {
  const root = path.join(fixture.root, relativeRoot);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"edge","private":true}\n');
  await fs.writeFile(path.join(root, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(root, source), "export const edge = true;\n");
  return path.join(relativeRoot, source).split(path.sep).join("/");
}

async function createStandaloneBunRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2290-external-bun-root-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"external","private":true}\n');
  await fs.writeFile(path.join(root, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(root, "index.ts"), "export const edge = true;\n");
  return root;
}

async function createExternalFile(name: string, bytes: string | Uint8Array): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2317-external-input-"));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return file;
}

async function replaceBunLockWithExternal(root: string): Promise<void> {
  const lockPath = path.join(root, "bun.lock");
  const externalLock = await createExternalFile("bun.lock", "{}\n");
  await fs.rm(lockPath);
  await fs.symlink(externalLock, lockPath, "file");
}

async function replacePackageJsonWithExternal(root: string): Promise<void> {
  const packagePath = path.join(root, "package.json");
  const externalPackage = await createExternalFile(
    "package.json",
    '{"name":"external","private":true}\n',
  );
  await fs.rm(packagePath);
  await fs.symlink(externalPackage, packagePath, "file");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("managed gate closure v1", () => {
  test("rejects a gate closure manifest symlink outside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    const manifestPath = path.join(fixture.root, "cq-gate-closure.json");
    const externalManifest = await createExternalFile(
      "cq-gate-closure.json",
      await fs.readFile(manifestPath),
    );
    await fs.rm(manifestPath);
    await fs.symlink(externalManifest, manifestPath, "file");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a target Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    await replaceBunLockWithExternal(fixture.targetRoot);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a static-import root Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    const source = await addBunRoot(fixture, "nix/pkg/static-root");
    await replaceBunLockWithExternal(path.dirname(path.join(fixture.root, source)));
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { edge } from "../../static-root/index.js";\nvoid edge;\n',
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a static-import root package manifest symlink outside the repository", async () => {
    const fixture = await createFixture();
    const source = await addBunRoot(fixture, "nix/pkg/static-root");
    await replacePackageJsonWithExternal(path.dirname(path.join(fixture.root, source)));
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { edge } from "../../static-root/index.js";\nvoid edge;\n',
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a static-import root non-file package manifest", async () => {
    const fixture = await createFixture();
    const source = await addBunRoot(fixture, "nix/pkg/static-root");
    const packagePath = path.join(path.dirname(path.join(fixture.root, source)), "package.json");
    await fs.rm(packagePath);
    await fs.mkdir(packagePath);
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { edge } from "../../static-root/index.js";\nvoid edge;\n',
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("bun-root-incomplete");
  });

  test("rejects a declared target root Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes =
      'const modulePath = "../../../declared-root/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/declared-root");
    await replaceBunLockWithExternal(path.dirname(path.join(fixture.root, target)));
    await writeManifest(fixture, [
      {
        kind: "dynamic",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [target],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a manifest-declared source symlink outside the repository", async () => {
    const fixture = await createFixture();
    const sourceBytes =
      "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n";
    const sourcePath = path.join(fixture.targetRoot, "test", "external-source.ts");
    const externalSource = await createExternalFile("external-source.ts", sourceBytes);
    await fs.symlink(externalSource, sourcePath, "file");
    await writeManifest(fixture, [
      {
        kind: "path",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects an executable source symlink outside the repository", async () => {
    const fixture = await createFixture();
    const markerPath = path.join(fixture.root, "source-symlink-marker.txt");
    await fs.writeFile(markerPath, "executed\n");
    const sourceBytes = [
      'import { expect, test } from "bun:test";',
      "const markerPath = process.env.T2317_SOURCE_SYMLINK_MARKER;",
      'if (markerPath === undefined) throw new Error("missing source symlink marker");',
      "const marker = await Bun.file(markerPath).text();",
      'test("external source symlink executes", () => {',
      '  console.log("T2317_EXTERNAL_SOURCE_SYMLINK_EXECUTED");',
      '  expect(marker).toBe("executed\\n");',
      "});",
      "",
    ].join("\n");
    const externalSource = await createExternalFile("escaped.test.ts", sourceBytes);
    const sourcePath = path.join(fixture.targetRoot, "test", "escaped.test.ts");
    await fs.symlink(externalSource, sourcePath, "file");
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, "test", sourcePath], {
      env: { ...process.env, T2317_SOURCE_SYMLINK_MARKER: markerPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_EXTERNAL_SOURCE_SYMLINK_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects an executable variable-valued CommonJS require without a declaration", async () => {
    const fixture = await createFixture();
    const siblingSource = await addBunRoot(fixture, "nix/pkg/commonjs-sibling-root", "index.cjs");
    await fs.writeFile(
      path.join(fixture.root, siblingSource),
      'console.log("T2317_VARIABLE_REQUIRE_EXECUTED");\nmodule.exports = true;\n',
    );
    const sourcePath = path.join(fixture.targetRoot, "test", "variable-require.cjs");
    const sourceBytes = [
      'const modulePath = "../../commonjs-sibling-root/index.cjs";',
      "require(modulePath);",
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, sourceBytes);
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, sourcePath], {
      cwd: fixture.targetRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_VARIABLE_REQUIRE_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.reason).toBe("source-declaration-missing");
      expect(resolution.detail).toContain("test/variable-require.cjs");
    }
  });

  test("rejects an executable computed-member CommonJS require without a declaration", async () => {
    const fixture = await createFixture();
    const siblingSource = await addBunRoot(
      fixture,
      "nix/pkg/computed-commonjs-sibling-root",
      "index.cjs",
    );
    await fs.writeFile(
      path.join(fixture.root, siblingSource),
      'console.log("T2317_COMPUTED_MEMBER_REQUIRE_EXECUTED");\nmodule.exports = true;\n',
    );
    const sourcePath = path.join(fixture.targetRoot, "test", "computed-member-require.cjs");
    const sourceBytes = [
      'const modulePath = "../../computed-commonjs-sibling-root/index.cjs";',
      'module["require"](modulePath);',
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, sourceBytes);
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, sourcePath], {
      cwd: fixture.targetRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_COMPUTED_MEMBER_REQUIRE_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.reason).toBe("source-declaration-missing");
      expect(resolution.detail).toContain("test/computed-member-require.cjs");
    }
  });

  test("rejects an executable escaped-identifier CommonJS require", async () => {
    const fixture = await createFixture();
    const siblingSource = await addBunRoot(
      fixture,
      "nix/pkg/identifier-escape-commonjs-sibling-root",
      "index.cjs",
    );
    await fs.writeFile(
      path.join(fixture.root, siblingSource),
      'console.log("T2317_IDENTIFIER_ESCAPE_REQUIRE_EXECUTED");\nmodule.exports = true;\n',
    );
    const sourcePath = path.join(fixture.targetRoot, "test", "identifier-escape-require.cjs");
    await fs.writeFile(
      sourcePath,
      [
        'const modulePath = "../../identifier-escape-commonjs-sibling-root/index.cjs";',
        "requ\\u0069re(modulePath);",
        "",
      ].join("\n"),
    );
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, sourcePath], {
      cwd: fixture.targetRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput =
      new TextDecoder().decode(executed.stdout) + new TextDecoder().decode(executed.stderr);
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_IDENTIFIER_ESCAPE_REQUIRE_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.reason).toBe("source-identifier-escape-unsupported");
      expect(resolution.detail).toContain("test/identifier-escape-require.cjs");
    }
  });

  test("rejects valid and malformed executable identifier Unicode escapes", async () => {
    for (const [name, sourceBytes] of [
      ["fixed-width", 'requ\\u0069re("./unclassified-fixed-width.cjs");\n'],
      ["code-point", '\\u{72}equire("./unclassified-code-point.cjs");\n'],
      [
        "template-expression",
        [
          "const target = process.env.MODULE_PATH;",
          "const rendered = " +
            String.fromCharCode(96) +
            "$" +
            "{requ\\u0069re(target)}" +
            String.fromCharCode(96) +
            ";",
          "void rendered;",
          "",
        ].join("\n"),
      ],
      ["malformed-fixed-width", "const invalid\\u00zz = true;\n"],
      ["malformed-code-point", "const invalid\\u{110000} = true;\n"],
    ] as const) {
      const fixture = await createFixture();
      const sourcePath = path.join(fixture.targetRoot, "test", name + "-identifier-escape.cjs");
      await fs.writeFile(sourcePath, sourceBytes);
      await writeManifest(fixture);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-identifier-escape-unsupported");
        expect(resolution.detail).toContain("test/" + name + "-identifier-escape.cjs");
      }
    }
  });

  test("distinguishes pinned CommonJS execution from resolution", async () => {
    const fixture = await createFixture();
    const siblingSource = await addBunRoot(fixture, "nix/pkg/commonjs-family-root", "index.cjs");
    await fs.writeFile(
      path.join(fixture.root, siblingSource),
      'console.log("T2317_COMMONJS_TARGET_EXECUTED");\nmodule.exports = true;\n',
    );
    const moduleSpecifier = "../../commonjs-family-root/index.cjs";
    for (const measurement of [
      {
        name: "direct-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nrequire(target);\n`,
        executes: true,
      },
      {
        name: "module-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nmodule.require(target);\n`,
        executes: true,
      },
      {
        name: "computed-module-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nmodule["require"](target);\n`,
        executes: true,
      },
      {
        name: "dynamic-computed-module-require",
        source: `const property = "require";\nconst target = ${JSON.stringify(moduleSpecifier)};\nmodule[property](target);\n`,
        executes: true,
      },
      {
        name: "parenthesized-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\n(require)(target);\n`,
        executes: true,
      },
      {
        name: "parenthesized-module-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\n(module.require)(target);\n`,
        executes: true,
      },
      {
        name: "main-require",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nrequire.main.require(target);\n`,
        executes: true,
      },
      {
        name: "require-call",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nrequire.call(null, target);\n`,
        executes: true,
      },
      {
        name: "module-require-apply",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nmodule.require.apply(module, [target]);\n`,
        executes: true,
      },
      {
        name: "require-alias",
        source: `const load = require;\nconst target = ${JSON.stringify(moduleSpecifier)};\nload(target);\n`,
        executes: true,
      },
      {
        name: "module-require-alias",
        source: `const load = module.require;\nconst target = ${JSON.stringify(moduleSpecifier)};\nload(target);\n`,
        executes: true,
      },
      {
        name: "computed-module-require-alias",
        source: `const load = module["require"];\nconst target = ${JSON.stringify(moduleSpecifier)};\nload(target);\n`,
        executes: true,
      },
      {
        name: "destructured-module-require-alias",
        source: `const { require: load } = module;\nconst target = ${JSON.stringify(moduleSpecifier)};\nload(target);\n`,
        executes: true,
      },
      {
        name: "created-require",
        source: [
          'const { createRequire } = require("node:module");',
          "const load = createRequire(__filename);",
          `const target = ${JSON.stringify(moduleSpecifier)};`,
          "load(target);",
          "",
        ].join("\n"),
        executes: true,
      },
      {
        name: "require-resolve",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nconsole.log(require.resolve(target));\n`,
        executes: false,
      },
      {
        name: "computed-require-resolve",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nconsole.log(require["resolve"](target));\n`,
        executes: false,
      },
      {
        name: "parenthesized-require-resolve",
        source: `const target = ${JSON.stringify(moduleSpecifier)};\nconsole.log((require.resolve)(target));\n`,
        executes: false,
      },
      {
        name: "require-resolve-alias",
        source: `const resolveModule = require.resolve;\nconst target = ${JSON.stringify(moduleSpecifier)};\nconsole.log(resolveModule(target));\n`,
        executes: false,
      },
    ] as const) {
      const sourcePath = path.join(fixture.targetRoot, "test", `${measurement.name}.cjs`);
      await fs.writeFile(sourcePath, measurement.source);
      const result = Bun.spawnSync([process.execPath, sourcePath], {
        cwd: fixture.targetRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
      expect(result.exitCode).toBe(0);
      expect(output.includes("T2317_COMMONJS_TARGET_EXECUTED")).toBe(measurement.executes);
      if (!measurement.executes) {
        expect(output).toContain(path.join(fixture.root, siblingSource));
      }
    }
  });

  test("classifies non-literal CommonJS loading and resolution forms as dynamic", async () => {
    for (const commonJsSource of [
      "const target = process.env.MODULE_PATH;\nrequire(target);\n",
      "const target = process.env.MODULE_PATH;\nmodule.require(target);\n",
      'const target = process.env.MODULE_PATH;\nmodule["require"](target);\n',
      'const property = "require";\nconst target = process.env.MODULE_PATH;\nmodule[property](target);\n',
      "const target = process.env.MODULE_PATH;\n(require)(target);\n",
      "const target = process.env.MODULE_PATH;\n(module.require)(target);\n",
      "const target = process.env.MODULE_PATH;\nrequire.main.require(target);\n",
      "const target = process.env.MODULE_PATH;\nrequire.call(null, target);\n",
      "const target = process.env.MODULE_PATH;\nmodule.require.apply(module, [target]);\n",
      "const load = require;\nconst target = process.env.MODULE_PATH;\nload(target);\n",
      "const load = module.require;\nconst target = process.env.MODULE_PATH;\nload(target);\n",
      'const load = module["require"];\nconst target = process.env.MODULE_PATH;\nload(target);\n',
      "const { require: load } = module;\nconst target = process.env.MODULE_PATH;\nload(target);\n",
      [
        'const { createRequire } = require("node:module");',
        "const load = createRequire(__filename);",
        "const target = process.env.MODULE_PATH;",
        "load(target);",
        "",
      ].join("\n"),
      [
        'const { createRequire } = require("node:module");',
        "const load = createRequire(__filename);",
        "const target = process.env.MODULE_PATH;",
        "load.resolve(target);",
        "",
      ].join("\n"),
      [
        'const { createRequire } = require("node:module");',
        "const load = createRequire(__filename);",
        "const target = process.env.MODULE_PATH;",
        "load.call(null, target);",
        "",
      ].join("\n"),
      "const target = process.env.MODULE_PATH;\nrequire.resolve(target);\n",
      'const target = process.env.MODULE_PATH;\nrequire["resolve"](target);\n',
      "const target = process.env.MODULE_PATH;\n(require.resolve)(target);\n",
      "const resolveModule = require.resolve;\nconst target = process.env.MODULE_PATH;\nresolveModule(target);\n",
      "const segment = process.env.MODULE_NAME;\nrequire(`./${segment}.cjs`);\n",
      "const target = process.env.MODULE_PATH;\nconst loaded = `${require(target)}`;\n",
      "const target = process.env.MODULE_PATH;\nrequire /* loader */ (target);\n",
      "const load = require;\nconst target = process.env.MODULE_PATH;\nload(target);\n",
      "const target = process.env.MODULE_PATH;\nrequire.call(null, target);\n",
      "const bound = require.bind(null);\nconst target = process.env.MODULE_PATH;\nbound(target);\n",
      "const loaders = [require];\nconst target = process.env.MODULE_PATH;\nloaders[0](target);\n",
    ]) {
      const fixture = await createFixture();
      const sourcePath = path.join(fixture.targetRoot, "test", "commonjs-load.cjs");
      await fs.writeFile(sourcePath, commonJsSource);
      await writeManifest(fixture);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-declaration-missing");
        expect(resolution.detail).toContain("opaque dynamic edge");
      }
    }
  });

  test("ignores CommonJS loader spellings outside executable code", async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "non-code-require.cjs"),
      [
        "// require(commentTarget);",
        '// module["require"](computedCommentTarget);',
        "/* const load = require; load(blockTarget); */",
        'const quoted = "require(stringTarget)";',
        'const computed = `module["require"](computedStringTarget)`;',
        "const templated = `require(templateTarget)`;",
        "const pattern = /require\\(regexTarget\\)/u;",
        "// requ\\u0069re(escapedCommentTarget);",
        "/* \\u{72}equire(escapedBlockCommentTarget); */",
        'const escapedQuoted = "requ\\u0069re(escapedStringTarget)";',
        "const escapedTemplate = " +
          String.fromCharCode(96) +
          "requ\\u{69}re(escapedTemplateTarget)" +
          String.fromCharCode(96) +
          ";",
        "const escapedPattern = /requ\\u0069re\\(escapedRegexTarget\\)/u;",
        "void quoted;",
        "void computed;",
        "void templated;",
        "void pattern;",
        "void escapedQuoted;",
        "void escapedTemplate;",
        "void escapedPattern;",
        "",
      ].join("\n"),
    );
    await writeManifest(fixture);

    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("binds dynamic CommonJS targets and preserves literal CommonJS roots", async () => {
    for (const [name, dynamicSourceBytes] of [
      ["member", "const target = process.env.MODULE_PATH;\nmodule.require(target);\n"],
      ["computed", 'const target = process.env.MODULE_PATH;\nmodule["require"](target);\n'],
      ["parenthesized", "const target = process.env.MODULE_PATH;\n(require)(target);\n"],
      ["call", "const target = process.env.MODULE_PATH;\nrequire.call(null, target);\n"],
      [
        "apply",
        "const target = process.env.MODULE_PATH;\nmodule.require.apply(module, [target]);\n",
      ],
      ["alias", "const load = require;\nconst target = process.env.MODULE_PATH;\nload(target);\n"],
      [
        "computed-alias",
        'const load = module["require"];\nconst target = process.env.MODULE_PATH;\nload(target);\n',
      ],
      [
        "destructured-alias",
        "const { require: load } = module;\nconst target = process.env.MODULE_PATH;\nload(target);\n",
      ],
      [
        "computed-resolve",
        'const target = process.env.MODULE_PATH;\nrequire["resolve"](target);\n',
      ],
      [
        "resolve-alias",
        "const resolveModule = require.resolve;\nconst target = process.env.MODULE_PATH;\nresolveModule(target);\n",
      ],
    ] as const) {
      const dynamicFixture = await createFixture();
      const dynamicSourcePath = path.join(dynamicFixture.targetRoot, "test", `dynamic-${name}.cjs`);
      await fs.writeFile(dynamicSourcePath, dynamicSourceBytes);
      const dynamicTarget = await addBunRoot(
        dynamicFixture,
        "nix/pkg/dynamic-commonjs-root",
        "index.cjs",
      );
      await writeManifest(dynamicFixture, [
        {
          kind: "dynamic",
          source: path.relative(dynamicFixture.root, dynamicSourcePath).split(path.sep).join("/"),
          sha256: digest(dynamicSourceBytes),
          targets: [dynamicTarget],
        },
      ]);

      const dynamicResolution = await resolveManagedGateClosure(dynamicFixture.root);
      expect(dynamicResolution.status).toBe("resolved");
      if (dynamicResolution.status === "resolved") {
        expect(dynamicResolution.installRoots).toEqual([
          dynamicFixture.targetRoot,
          path.join(dynamicFixture.root, "nix/pkg/dynamic-commonjs-root"),
        ]);
      }

      await fs.appendFile(dynamicSourcePath, "// source drift\n");
      const driftedResolution = await resolveManagedGateClosure(dynamicFixture.root);
      expect(driftedResolution.status).toBe("invalid");
      if (driftedResolution.status === "invalid") {
        expect(driftedResolution.reason).toBe("source-digest-mismatch");
      }
    }

    for (const literalSource of [
      'require("../../literal-commonjs-root/index.cjs");\n',
      'require /* loader */ ("../../literal-commonjs-root/index.cjs");\n',
      'module["require"]("../../literal-commonjs-root/index.cjs");\n',
      '(require)("../../literal-commonjs-root/index.cjs");\n',
      '(module.require)("../../literal-commonjs-root/index.cjs");\n',
      'require.call(null, "../../literal-commonjs-root/index.cjs");\n',
      'module.require.apply(module, ["../../literal-commonjs-root/index.cjs"]);\n',
      'const load = require;\nload("../../literal-commonjs-root/index.cjs");\n',
      'const load = module.require;\nload("../../literal-commonjs-root/index.cjs");\n',
      'const load = module["require"];\nload("../../literal-commonjs-root/index.cjs");\n',
      'const { require: load } = module;\nload("../../literal-commonjs-root/index.cjs");\n',
      'require.resolve("../../literal-commonjs-root/index.cjs");\n',
      'require["resolve"]("../../literal-commonjs-root/index.cjs");\n',
      '(require.resolve)("../../literal-commonjs-root/index.cjs");\n',
      'const resolveModule = require.resolve;\nresolveModule("../../literal-commonjs-root/index.cjs");\n',
      [
        'const { createRequire } = require("node:module");',
        "const load = createRequire(__filename);",
        'load("../../literal-commonjs-root/index.cjs");',
        "",
      ].join("\n"),
      [
        'const { createRequire } = require("node:module");',
        "const load = createRequire(__filename);",
        'load.resolve("../../literal-commonjs-root/index.cjs");',
        "",
      ].join("\n"),
      [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'require.resolve("../../literal-commonjs-root/index.cjs");',
        'require.resolve.paths("literal-commonjs-root");',
        "",
      ].join("\n"),
    ]) {
      const fixture = await createFixture();
      await addBunRoot(fixture, "nix/pkg/literal-commonjs-root", "index.cjs");
      await fs.writeFile(
        path.join(fixture.targetRoot, "test", "literal-require.cjs"),
        literalSource,
      );
      await writeManifest(fixture);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("resolved");
      if (resolution.status === "resolved") {
        expect(resolution.installRoots).toEqual([
          fixture.targetRoot,
          path.join(fixture.root, "nix/pkg/literal-commonjs-root"),
        ]);
      }
    }
  });

  test("rejects an executable Bun test preload outside the repository", async () => {
    const fixture = await createFixture();
    const externalPreload = await createExternalFile(
      "external-preload.ts",
      'console.log("T2317_EXTERNAL_BUNFIG_PRELOAD_EXECUTED");\n',
    );
    const preloadSpecifier = path
      .relative(fixture.targetRoot, externalPreload)
      .split(path.sep)
      .join("/");
    await fs.writeFile(
      path.join(fixture.targetRoot, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(preloadSpecifier)}]\n`,
    );
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { expect, test } from "bun:test";\ntest("gate", () => expect(true).toBe(true));\n',
    );
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, "test", "test/gate.test.ts"], {
      cwd: fixture.targetRoot,
      env: {
        ...process.env,
        HOME: path.join(fixture.root, "home"),
        XDG_CONFIG_HOME: path.join(fixture.root, "xdg"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_EXTERNAL_BUNFIG_PRELOAD_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("binds target-local Bun configuration and preload bytes", async () => {
    const fixture = await createFixture();
    const preloadPath = path.join(fixture.targetRoot, "test", "configured-preload.ts");
    const preloadBytes = "export const configuredPreload = true;\n";
    const configBytes = '[test]\npreload = "./test/configured-preload.ts"\n';
    const configPath = path.join(fixture.targetRoot, "bunfig.toml");
    const configRelative = path.relative(fixture.root, configPath).split(path.sep).join("/");
    const preloadRelative = path.relative(fixture.root, preloadPath).split(path.sep).join("/");
    await fs.writeFile(configPath, configBytes);
    await fs.writeFile(preloadPath, preloadBytes);

    await writeManifest(fixture);
    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
      expect(undeclared.detail).toContain(configRelative);
    }

    const configurationEdge: ManagedGateOpaqueEdgeDeclaration = {
      kind: "path",
      source: configRelative,
      sha256: digest(configBytes),
      targets: [preloadRelative],
    };
    const preloadEdge: ManagedGateOpaqueEdgeDeclaration = {
      kind: "path",
      source: preloadRelative,
      sha256: digest(preloadBytes),
      targets: [],
    };
    await writeManifest(fixture, [{ ...configurationEdge, targets: [] }, preloadEdge]);
    const uncovered = await resolveManagedGateClosure(fixture.root);
    expect(uncovered.status).toBe("invalid");
    if (uncovered.status === "invalid") {
      expect(uncovered.reason).toBe("source-declaration-missing");
      expect(uncovered.detail).toContain("does not exactly cover");
    }

    await writeManifest(fixture, [configurationEdge]);
    const unboundPreload = await resolveManagedGateClosure(fixture.root);
    expect(unboundPreload.status).toBe("invalid");
    if (unboundPreload.status === "invalid") {
      expect(unboundPreload.reason).toBe("source-declaration-missing");
      expect(unboundPreload.detail).toContain(preloadRelative);
    }

    await writeManifest(fixture, [configurationEdge, preloadEdge]);
    const resolved = await resolveManagedGateClosure(fixture.root);
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") expect(resolved.installRoots).toEqual([fixture.targetRoot]);

    await fs.appendFile(configPath, "# configuration drift\n");
    const changedConfiguration = await resolveManagedGateClosure(fixture.root);
    expect(changedConfiguration.status).toBe("invalid");
    if (changedConfiguration.status === "invalid") {
      expect(changedConfiguration.reason).toBe("source-digest-mismatch");
    }

    await fs.writeFile(configPath, configBytes);
    await fs.appendFile(preloadPath, "// preload drift\n");
    const changedPreload = await resolveManagedGateClosure(fixture.root);
    expect(changedPreload.status).toBe("invalid");
    if (changedPreload.status === "invalid") {
      expect(changedPreload.reason).toBe("source-digest-mismatch");
    }
  });

  test("uses only target-local Bun configuration under pinned precedence", async () => {
    const fixture = await createFixture();
    const localPreloadPath = path.join(fixture.targetRoot, "test", "local-preload.ts");
    const localPreloadBytes = 'console.log("T2317_LOCAL_BUNFIG_PRELOAD");\n';
    const externalPreload = await createExternalFile(
      "ancestor-preload.ts",
      'console.log("T2317_ANCESTOR_BUNFIG_PRELOAD");\n',
    );
    const localConfigBytes = '[test]\npreload = ["./test/local-preload.ts"]\n';
    const ancestorConfigBytes = `[test]\npreload = [${JSON.stringify(
      path.relative(fixture.root, externalPreload).split(path.sep).join("/"),
    )}]\n`;
    const localConfigPath = path.join(fixture.targetRoot, "bunfig.toml");
    const localConfigRelative = path
      .relative(fixture.root, localConfigPath)
      .split(path.sep)
      .join("/");
    const localPreloadRelative = path
      .relative(fixture.root, localPreloadPath)
      .split(path.sep)
      .join("/");
    await fs.writeFile(localConfigPath, localConfigBytes);
    await fs.writeFile(localPreloadPath, localPreloadBytes);
    await fs.writeFile(path.join(fixture.root, "bunfig.toml"), ancestorConfigBytes);
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { test } from "bun:test";\ntest("gate", () => {});\n',
    );
    await writeManifest(fixture, [
      {
        kind: "path",
        source: localConfigRelative,
        sha256: digest(localConfigBytes),
        targets: [localPreloadRelative],
      },
      {
        kind: "path",
        source: localPreloadRelative,
        sha256: digest(localPreloadBytes),
        targets: [],
      },
    ]);

    const executed = Bun.spawnSync([process.execPath, "test", "test/gate.test.ts"], {
      cwd: fixture.targetRoot,
      env: {
        ...process.env,
        HOME: path.join(fixture.root, "home"),
        XDG_CONFIG_HOME: path.join(fixture.root, "xdg"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_LOCAL_BUNFIG_PRELOAD");
    expect(executionOutput).not.toContain("T2317_ANCESTOR_BUNFIG_PRELOAD");
    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("scans an internal configured test root through ordinary edge validation", async () => {
    const fixture = await createFixture();
    const configuredSource = await addBunRoot(
      fixture,
      "nix/pkg/configured-tests",
      "configured.test.ts",
    );
    const configuredSourcePath = path.join(fixture.root, configuredSource);
    const configuredSourceBytes =
      "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n";
    const configBytes = '[test]\nroot = "../configured-tests"\n';
    const configPath = path.join(fixture.targetRoot, "bunfig.toml");
    const configRelative = path.relative(fixture.root, configPath).split(path.sep).join("/");
    await fs.writeFile(configuredSourcePath, configuredSourceBytes);
    await fs.writeFile(configPath, configBytes);
    const configurationEdge: ManagedGateOpaqueEdgeDeclaration = {
      kind: "path",
      source: configRelative,
      sha256: digest(configBytes),
      targets: ["nix/pkg/configured-tests"],
    };
    await writeManifest(fixture, [configurationEdge]);

    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
      expect(undeclared.detail).toContain(configuredSource);
    }

    await writeManifest(fixture, [
      configurationEdge,
      {
        kind: "path",
        source: configuredSource,
        sha256: digest(configuredSourceBytes),
        targets: [],
      },
    ]);
    const resolved = await resolveManagedGateClosure(fixture.root);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.installRoots).toEqual([
      fixture.targetRoot,
      path.join(fixture.root, "nix/pkg/configured-tests"),
    ]);
  });

  test("rejects external and unsupported executable Bun configuration constructs", async () => {
    const escaped = await createFixture();
    const externalConfig = await createExternalFile(
      "bunfig.toml",
      '[test]\npreload = ["./setup.ts"]\n',
    );
    await fs.symlink(externalConfig, path.join(escaped.targetRoot, "bunfig.toml"), "file");
    await writeManifest(escaped);
    const escapedResolution = await resolveManagedGateClosure(escaped.root);
    expect(escapedResolution.status).toBe("invalid");
    if (escapedResolution.status === "invalid") {
      expect(escapedResolution.reason).toBe("path-escape");
    }

    for (const configured of [
      {
        bytes: 'preload = ["./test/gate.test.ts"]\n',
        reason: "bun-configuration-unsupported",
      },
      {
        bytes: '[test]\npreload = ["package-preload"]\n',
        reason: "bun-configuration-unsupported",
      },
      {
        bytes: '[install.security]\nscanner = "scanner-package"\n',
        reason: "bun-configuration-unsupported",
      },
      {
        bytes: '[serve.static]\nplugins = ["./plugin.ts"]\n',
        reason: "bun-configuration-unsupported",
      },
      { bytes: "[test]\npreload = 42\n", reason: "bun-configuration-invalid" },
    ] as const) {
      const fixture = await createFixture();
      await fs.writeFile(path.join(fixture.targetRoot, "bunfig.toml"), configured.bytes);
      await writeManifest(fixture);
      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") expect(resolution.reason).toBe(configured.reason);
    }
  });

  test("validates a source symlink target that remains inside the repository", async () => {
    const fixture = await createFixture();
    const sourceBytes =
      "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n";
    const inputsRoot = path.join(fixture.root, "gate-inputs");
    await fs.mkdir(inputsRoot);
    const internalSource = path.join(inputsRoot, "internal-source.test.ts");
    await fs.writeFile(internalSource, sourceBytes);
    const sourcePath = path.join(fixture.targetRoot, "test", "internal-source.test.ts");
    await fs.symlink(path.relative(path.dirname(sourcePath), internalSource), sourcePath, "file");
    await writeManifest(fixture);

    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
      expect(undeclared.detail).toContain("gate-inputs/internal-source.test.ts");
    }

    await writeManifest(fixture, [
      {
        kind: "path",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);
    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("terminates discovery through an internal source symlink directory cycle", async () => {
    const fixture = await createFixture();
    await fs.symlink(
      fixture.targetRoot,
      path.join(fixture.targetRoot, "test", "target-loop"),
      "dir",
    );
    await writeManifest(fixture);

    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("accepts manifest and Bun lock symlinks that remain inside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    const inputsRoot = path.join(fixture.root, "gate-inputs");
    await fs.mkdir(inputsRoot);

    const manifestPath = path.join(fixture.root, "cq-gate-closure.json");
    const internalManifest = path.join(inputsRoot, "cq-gate-closure.json");
    await fs.rename(manifestPath, internalManifest);
    await fs.symlink(internalManifest, manifestPath, "file");

    const lockPath = path.join(fixture.targetRoot, "bun.lock");
    const internalLock = path.join(inputsRoot, "bun.lock");
    await fs.rename(lockPath, internalLock);
    await fs.symlink(internalLock, lockPath, "file");

    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("rejects target script DAG divergence and missing script edges", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    await fs.writeFile(
      path.join(fixture.targetRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "target",
          private: true,
          scripts: { ...fixture.scripts, check: "tsc -b && bun run lint && bun test --bail" },
        },
        null,
        2,
      )}\n`,
    );
    const diverged = await resolveManagedGateClosure(fixture.root);
    expect(diverged.status).toBe("invalid");
    if (diverged.status === "invalid") expect(diverged.reason).toBe("target-diverged");

    const missingFixture = await createFixture({ check: "bun run absent" });
    const missingManifest: ManagedGateClosureManifestV1 = {
      version: 1,
      target: {
        packageJson: TARGET_PACKAGE,
        script: "check",
        scriptDagSha256: "0".repeat(64),
      },
      opaqueEdges: [],
    };
    await fs.writeFile(
      path.join(missingFixture.root, "cq-gate-closure.json"),
      `${JSON.stringify(missingManifest, null, 2)}\n`,
    );
    const missing = await resolveManagedGateClosure(missingFixture.root);
    expect(missing.status).toBe("invalid");
    if (missing.status === "invalid") expect(missing.reason).toBe("script-edge-missing");
  });

  test("selects static-import roots and excludes unreachable Bun roots", async () => {
    const fixture = await createFixture();
    const reachableSource = await addBunRoot(fixture, "nix/pkg/reachable");
    await addBunRoot(fixture, "nix/pkg/unreachable");
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      `import { edge } from "../../reachable/index.js";\nvoid edge;\n`,
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.dirname(path.join(fixture.root, reachableSource)),
    ]);
    expect(resolution.installRoots).not.toContain(path.join(fixture.root, "nix/pkg/unreachable"));
  });

  test("rejects resolved static and declared targets outside the repository", async () => {
    const staticFixture = await createFixture();
    const staticExternalRoot = await createStandaloneBunRoot();
    const sourcePath = path.join(staticFixture.targetRoot, "test", "gate.test.ts");
    const externalSpecifier = path
      .relative(path.dirname(sourcePath), path.join(staticExternalRoot, "index.ts"))
      .split(path.sep)
      .join("/");
    await fs.writeFile(sourcePath, `import { edge } from ${JSON.stringify(externalSpecifier)};\n`);
    await writeManifest(staticFixture);

    const staticResolution = await resolveManagedGateClosure(staticFixture.root);
    expect(staticResolution.status).toBe("invalid");
    if (staticResolution.status === "invalid") {
      expect(staticResolution.reason).toBe("path-escape");
    }

    const missingFixture = await createFixture();
    await fs.writeFile(
      path.join(missingFixture.targetRoot, "test", "gate.test.ts"),
      ["im", 'port "../../../../../../outside-repository.ts";\n'].join(""),
    );
    await writeManifest(missingFixture);
    const missingResolution = await resolveManagedGateClosure(missingFixture.root);
    expect(missingResolution.status).toBe("invalid");
    if (missingResolution.status === "invalid") {
      expect(missingResolution.reason).toBe("path-escape");
    }

    const declaredFixture = await createFixture();
    const declaredExternalRoot = await createStandaloneBunRoot();
    const linkRoot = path.join(declaredFixture.root, "nix/pkg/external-link");
    await fs.mkdir(path.dirname(linkRoot), { recursive: true });
    await fs.symlink(declaredExternalRoot, linkRoot, "dir");
    const declaredSourcePath = path.join(declaredFixture.targetRoot, "test", "gate.test.ts");
    const declaredSourceBytes =
      'const modulePath = "../../../external-link/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(declaredSourcePath, declaredSourceBytes);
    await writeManifest(declaredFixture, [
      {
        kind: "dynamic",
        source: path.relative(declaredFixture.root, declaredSourcePath).split(path.sep).join("/"),
        sha256: digest(declaredSourceBytes),
        targets: ["nix/pkg/external-link/index.ts"],
      },
    ]);

    const declaredResolution = await resolveManagedGateClosure(declaredFixture.root);
    expect(declaredResolution.status).toBe("invalid");
    if (declaredResolution.status === "invalid") {
      expect(declaredResolution.reason).toBe("path-escape");
    }
  });

  test("canonicalizes target roots and rejects target symlinks outside the repository", async () => {
    const externalFixture = await createFixture();
    await writeManifest(externalFixture);
    const externalTargetRoot = await createStandaloneBunRoot();
    await fs.writeFile(
      path.join(externalTargetRoot, "package.json"),
      `${JSON.stringify(
        { name: "external", private: true, scripts: externalFixture.scripts },
        null,
        2,
      )}\n`,
    );
    await fs.rm(externalFixture.targetRoot, { recursive: true });
    await fs.symlink(externalTargetRoot, externalFixture.targetRoot, "dir");

    const externalResolution = await resolveManagedGateClosure(externalFixture.root);
    expect(externalResolution.status).toBe("invalid");
    if (externalResolution.status === "invalid") {
      expect(externalResolution.reason).toBe("path-escape");
    }

    const internalFixture = await createFixture();
    await writeManifest(internalFixture);
    const internalTargetRoot = path.join(internalFixture.root, "nix/pkg/cq-ledgers-real");
    await fs.rename(internalFixture.targetRoot, internalTargetRoot);
    await fs.symlink(internalTargetRoot, internalFixture.targetRoot, "dir");

    const internalResolution = await resolveManagedGateClosure(internalFixture.root);
    expect(internalResolution.status).toBe("resolved");
    if (internalResolution.status !== "resolved") return;
    expect(internalResolution.targetPackageJson).toBe(
      path.join(internalTargetRoot, "package.json"),
    );
    expect(internalResolution.installRoots).toEqual([internalTargetRoot]);
  });

  test("fails closed for an undeclared dynamic edge", async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'const modulePath = "./fixture.ts";\nawait import(modulePath);\n',
    );
    await fs.writeFile(path.join(fixture.targetRoot, "test", "fixture.ts"), "export {};\n");
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.reason).toBe("source-declaration-missing");
      expect(resolution.detail).toContain("test/gate.test.ts");
    }
  });

  test("requires matching declarations for opaque path and spawn edges", async () => {
    for (const edge of [
      {
        expectedKind: "path" as const,
        wrongKind: "spawn" as const,
        source: "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n",
      },
      {
        expectedKind: "spawn" as const,
        wrongKind: "path" as const,
        source:
          'import { spawn } from "node:child_process";\nconst scriptPath = process.env.SCRIPT_PATH!;\nspawn(process.execPath, [scriptPath]);\n',
      },
    ]) {
      const fixture = await createFixture();
      const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
      await fs.writeFile(sourcePath, edge.source);
      const target = await addBunRoot(fixture, `nix/pkg/${edge.expectedKind}-target`);
      await writeManifest(fixture, [
        {
          kind: edge.wrongKind,
          source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
          sha256: digest(edge.source),
          targets: [target],
        },
      ]);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-declaration-missing");
        expect(resolution.detail).toContain(`hashed ${edge.expectedKind} edge declaration`);
      }
    }
  });

  test("requires declarations for CommonJS path and spawn aliases", async () => {
    for (const edge of [
      {
        expectedKind: "path",
        sourceName: "opaque-path.cjs",
        source: [
          'const { readFile: loadAsset } = require("node:fs/promises");',
          "const assetPath = process.env.ASSET_PATH;",
          "await loadAsset(assetPath);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-spawn.cts",
        source: [
          'const processes = require("node:child_process");',
          "const scriptPath = process.env.SCRIPT_PATH;",
          "processes.spawn(process.execPath, [scriptPath]);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-destructured-spawn.cjs",
        source: [
          'const processes = require("node:child_process");',
          "const { spawn: run } = processes;",
          "const scriptPath = process.env.SCRIPT_PATH;",
          "run(process.execPath, [scriptPath]);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-one-line-destructured-spawn.cjs",
        source:
          'const processes = require("node:child_process"); const { spawn: run } = processes; const scriptPath = process.env.SCRIPT_PATH; run(process.execPath, [scriptPath]);\n',
      },
    ] as const) {
      const fixture = await createFixture();
      await fs.writeFile(path.join(fixture.targetRoot, "test", edge.sourceName), edge.source);
      await writeManifest(fixture);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-declaration-missing");
        expect(resolution.detail).toContain(`hashed ${edge.expectedKind} edge declaration`);
      }
    }
  });

  test("rejects targetless declarations for variable dynamic imports", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes = 'const modulePath = "./fixture.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    await fs.writeFile(path.join(fixture.targetRoot, "test", "fixture.ts"), "export {};\n");
    await writeManifest(fixture, [
      {
        kind: "dynamic",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("edge-target-missing");
  });

  test("admits opaque path and spawn edges with matching hashed targets", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes = [
      "const assetPath = process.env.ASSET_PATH!;",
      "await Bun.file(assetPath).text();",
      "const scriptPath = process.env.SCRIPT_PATH!;",
      "await Bun.spawn([process.execPath, scriptPath]).exited;",
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/opaque-target");
    const declaration = {
      source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
      sha256: digest(sourceBytes),
      targets: [target],
    };
    await writeManifest(fixture, [
      { kind: "path", ...declaration },
      { kind: "spawn", ...declaration },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.join(fixture.root, "nix/pkg/opaque-target"),
    ]);
  });

  test("admits a declared temporary root only while its source digest matches", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes =
      'const modulePath = "../../../temporary/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/temporary");
    const declaration: ManagedGateOpaqueEdgeDeclaration = {
      kind: "dynamic",
      source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
      sha256: digest(sourceBytes),
      targets: [target],
    };
    await writeManifest(fixture, [declaration]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.join(fixture.root, "nix/pkg/temporary"),
    ]);

    await fs.appendFile(sourcePath, "export {};\n");
    const changed = await resolveManagedGateClosure(fixture.root);
    expect(changed.status).toBe("invalid");
    if (changed.status === "invalid") expect(changed.reason).toBe("source-digest-mismatch");
  });

  test("requires hashed declarations for reachable Nix commands and complete target roots", async () => {
    const scripts = { check: "bun run nix-check", "nix-check": "cd ../../.. && nix build .#cq" };
    const fixture = await createFixture(scripts);
    await writeManifest(fixture);
    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
    }

    const packageBytes = await fs.readFile(path.join(fixture.root, TARGET_PACKAGE), "utf8");
    await writeManifest(fixture, [
      {
        kind: "nix",
        source: TARGET_PACKAGE,
        sha256: digest(packageBytes),
        targets: [],
      },
    ]);
    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");

    await fs.rm(path.join(fixture.targetRoot, "bun.lock"));
    const incomplete = await resolveManagedGateClosure(fixture.root);
    expect(incomplete.status).toBe("invalid");
    if (incomplete.status === "invalid") expect(incomplete.reason).toBe("bun-root-incomplete");
  });
});

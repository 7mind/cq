import path from "node:path";
import fs from "node:fs/promises";

export type WebBuild = Readonly<{
  outdir: string;
  scriptPath: string; // absolute URL path served to browser e.g. "/main.js"
}>;

const WEB_SRC = path.resolve(
  import.meta.dir,
  "../../../packages/web/src/main.tsx",
);
// CQ_WEB_OUTDIR lets a Nix package (or any read-only deployment) redirect the
// bundler output to a writable path (e.g. $HOME/.cache/cq/web-dist).
const WEB_OUTDIR =
  process.env["CQ_WEB_OUTDIR"] ??
  path.resolve(import.meta.dir, "../../../packages/web/dist");
const WEB_INDEX = path.join(WEB_OUTDIR, "index.html");

export async function buildWeb(): Promise<WebBuild> {
  const result = await Bun.build({
    entrypoints: [WEB_SRC],
    outdir: WEB_OUTDIR,
    target: "browser",
    minify: false,
    sourcemap: "linked",
    naming: "[name].[ext]",
  });

  if (!result.success) {
    const msgs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`Bun.build failed:\n${msgs}`);
  }

  // Determine the output JS filename (Bun emits "main.js" with naming:[name].[ext])
  const jsOutput = result.outputs.find((o) => o.kind === "entry-point");
  if (jsOutput === undefined) {
    throw new Error("Bun.build produced no entry-point output");
  }
  const scriptFile = path.basename(jsOutput.path);
  const scriptPath = `/${scriptFile}`;

  // Bun.build emits CSS module output as a separate asset file alongside the JS
  // entry point (e.g. main.css). Wire it into the HTML so the browser loads it.
  const cssOutput = result.outputs.find((o) => o.kind === "asset" && o.path.endsWith(".css"));
  const cssLink = cssOutput !== undefined
    ? `<link rel="stylesheet" href="/${path.basename(cssOutput.path)}">`
    : "";

  // Write index.html with correct script src and optional CSS link
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>cq</title>${cssLink}</head>
<body><div id="root"></div><script type="module" src="${scriptPath}"></script></body></html>
`;
  await fs.writeFile(WEB_INDEX, html, "utf8");

  return Object.freeze({ outdir: WEB_OUTDIR, scriptPath });
}

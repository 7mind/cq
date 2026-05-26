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
const WEB_OUTDIR = path.resolve(
  import.meta.dir,
  "../../../packages/web/dist",
);
const WEB_INDEX = path.resolve(
  import.meta.dir,
  "../../../packages/web/dist/index.html",
);

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

  // Write index.html with correct script src
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>cq</title></head>
<body><div id="root"></div><script type="module" src="${scriptPath}"></script></body></html>
`;
  await fs.writeFile(WEB_INDEX, html, "utf8");

  return Object.freeze({ outdir: WEB_OUTDIR, scriptPath });
}

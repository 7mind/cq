import type { ServerWebSocket } from "bun";
import {
  isSafeProjectKey,
  openXdgProjectRuntime,
  type ListProjectsCapability,
  type OpenXdgProjectRuntimeOptions,
  type XdgProjectRuntime,
} from "@cq/ledger";
import {
  attachMcpHttp,
  changedFrame,
  wsHeartbeat,
  type McpHttpHandlers,
  type PromptArtifactStore,
} from "@cq/ledger-mcp";
import { hubTopic, matchProjectRoute } from "./projectRoutes.js";
import { scanForPort, serveStatic } from "./serve.js";

export interface XdgHostProject {
  readonly key: string;
  readonly displayName: string;
}

export interface XdgHostCatalog {
  readonly projects: readonly XdgHostProject[];
  lookup(projectKey: string): XdgHostProject | null;
}

export type XdgRuntimeOpener = (
  options: OpenXdgProjectRuntimeOptions,
) => Promise<XdgProjectRuntime>;

export const filesystemXdgRuntimeOpener: XdgRuntimeOpener =
  openXdgProjectRuntime;

export interface XdgCatalogServeOpts {
  readonly host: string;
  readonly port: number;
  readonly projectsRoot: string;
  readonly outdir: string;
  readonly aliasProjectKey: string;
  readonly catalog: XdgHostCatalog;
  readonly runtimeOpener: XdgRuntimeOpener;
  readonly promptArtifactStore?: PromptArtifactStore;
}

export type SafeXdgProjectRoute =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "project";
      readonly projectKey: string;
      readonly leaf: "mcp" | "ws";
    };

interface XdgProjectHandlers {
  readonly runtime: XdgProjectRuntime;
  readonly handlers: McpHttpHandlers;
}

interface XdgWsData {
  readonly projectKey: string;
}

export function createStaticXdgHostCatalog(
  projects: readonly XdgHostProject[],
): XdgHostCatalog {
  const byKey = new Map<string, XdgHostProject>();
  const publicProjects = projects.map((project) => {
    if (!isSafeProjectKey(project.key)) {
      throw new Error(`invalid XDG catalog project key: ${JSON.stringify(project.key)}`);
    }
    if (byKey.has(project.key)) {
      throw new Error(`duplicate XDG catalog project key: ${project.key}`);
    }
    const entry = { key: project.key, displayName: project.displayName };
    byKey.set(entry.key, entry);
    return entry;
  });
  return {
    projects: publicProjects,
    lookup(projectKey: string): XdgHostProject | null {
      return byKey.get(projectKey) ?? null;
    },
  };
}

/**
 * Parse an XDG project route while rejecting unsafe keys before catalog or
 * filesystem access. A malformed path under `/p/` counts as an invalid project
 * route rather than falling through to the SPA.
 */
export function matchSafeXdgProjectRoute(pathname: string): SafeXdgProjectRoute {
  const rawMatch = /^\/p\/([^/]+)\/(mcp|ws)$/.exec(pathname);
  if (rawMatch === null) {
    return pathname.startsWith("/p/")
      ? { kind: "invalid" }
      : { kind: "none" };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawMatch[1]!);
  } catch {
    return { kind: "invalid" };
  }
  if (!isSafeProjectKey(decoded)) return { kind: "invalid" };
  const route = matchProjectRoute(pathname);
  if (route === null) {
    throw new Error("validated project route did not match");
  }
  return { kind: "project", ...route };
}

/**
 * Bind an HTTP/WebSocket host over one explicit, immutable XDG project
 * catalog. Project stores remain dormant until their first data request.
 */
export function serveXdgCatalog(
  opts: XdgCatalogServeOpts,
  indexPath: string,
): ReturnType<typeof Bun.serve> {
  const aliasProject = opts.catalog.projects.find(
    (project) => project.key === opts.aliasProjectKey,
  );
  if (aliasProject === undefined) {
    throw new Error(`XDG alias project is absent from catalog: ${opts.aliasProjectKey}`);
  }

  const listedProjects = opts.catalog.projects.map((project) => ({
    key: project.key,
    displayName: project.displayName,
  }));
  const listProjects: ListProjectsCapability = () => ({
    projects: listedProjects,
  });
  const runtimes = new Map<string, Promise<XdgProjectHandlers>>();

  function getRuntime(project: XdgHostProject): Promise<XdgProjectHandlers> {
    const existing = runtimes.get(project.key);
    if (existing !== undefined) return existing;
    const built = (async (): Promise<XdgProjectHandlers> => {
      const runtime = await opts.runtimeOpener({
        projectsRoot: opts.projectsRoot,
        projectKey: project.key,
        onMutation: (ledgerId) => {
          server.publish(hubTopic(project.key), changedFrame(ledgerId));
        },
      });
      const handlers = attachMcpHttp(
        runtime.store,
        project.displayName,
        "",
        runtime.configRoot,
        project.key,
        opts.promptArtifactStore,
        listProjects,
      );
      return { runtime, handlers };
    })();
    runtimes.set(project.key, built);
    void built.catch(() => {
      if (runtimes.get(project.key) === built) runtimes.delete(project.key);
    });
    return built;
  }

  async function routeProject(
    req: Request,
    srv: ReturnType<typeof Bun.serve>,
    project: XdgHostProject,
    leaf: "mcp" | "ws",
  ): Promise<Response | undefined> {
    let runtime: XdgProjectHandlers;
    try {
      runtime = await getRuntime(project);
    } catch {
      return new Response("project runtime unavailable", { status: 503 });
    }
    if (leaf === "mcp") return runtime.handlers.handle(req);
    if (srv.upgrade(req, { data: { projectKey: project.key } })) return undefined;
    return new Response("expected a websocket upgrade", { status: 426 });
  }

  const server = scanForPort(opts.port, (port) =>
    Bun.serve<XdgWsData>({
      hostname: opts.host,
      port,
      idleTimeout: 0,
      async fetch(req, srv): Promise<Response | undefined> {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          return routeProject(req, srv, aliasProject, "mcp");
        }
        if (url.pathname === "/ws") {
          return routeProject(req, srv, aliasProject, "ws");
        }
        const route = matchSafeXdgProjectRoute(url.pathname);
        if (route.kind === "invalid") {
          return new Response("invalid project route", { status: 400 });
        }
        if (route.kind === "project") {
          const project = opts.catalog.lookup(route.projectKey);
          if (project === null) {
            return new Response("unknown project", { status: 404 });
          }
          return routeProject(req, srv, project, route.leaf);
        }
        return serveStatic(url, opts.outdir, indexPath);
      },
      websocket: {
        open(ws: ServerWebSocket<XdgWsData>): void {
          ws.subscribe(hubTopic(ws.data.projectKey));
        },
        message(ws: ServerWebSocket<XdgWsData>, raw: string | Buffer): void {
          wsHeartbeat((frame) => ws.send(frame), raw);
        },
      },
    }),
  );

  const originalStop = server.stop.bind(server);
  let disposeRuntimes: Promise<void> | null = null;
  server.stop = async (closeActiveConnections?: boolean): Promise<void> => {
    // Always delegate to the native stop on every call — never memoize this
    // step. A first `stop()` (no force) can stay pending while a connection
    // is open; a later `stop(true)` must still reach `originalStop(true)` to
    // force-close it. Only the runtime disposal below is memoized, so it
    // still runs exactly once however many times `stop` is called.
    await originalStop(closeActiveConnections);
    disposeRuntimes ??= (async () => {
      const settled = await Promise.allSettled(runtimes.values());
      await Promise.all(
        settled.flatMap((result) =>
          result.status === "fulfilled"
            ? [result.value.runtime.dispose()]
            : [],
        ),
      );
    })();
    await disposeRuntimes;
  };
  return server;
}

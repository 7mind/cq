import React from "react";
import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import type {
  ProjectEntry,
  WorksetRequest,
  WorksetResultFor,
} from "@cq/ledger";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";

const ENTER = "\r";
const ESC = "\u001b";
const DOWN = "\u001b[B";
const CTRL_A = "\u0001";
const CTRL_D = "\u0004";
const CTRL_L = "\u000c";
const CTRL_P = "\u0010";

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  rendered: ReturnType<typeof render>,
  expected: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((rendered.lastFrame() ?? "").includes(expected)) return;
    await tick(10);
  }
  throw new Error(`workset frame never contained ${JSON.stringify(expected)}`);
}

async function press(rendered: ReturnType<typeof render>, key: string): Promise<void> {
  rendered.stdin.write(key);
  await tick();
}

async function typeText(rendered: ReturnType<typeof render>, value: string): Promise<void> {
  for (const character of value) await press(rendered, character);
}

class DeferredGetClient extends FakeClient {
  readonly getGates: Promise<void>[] = [];

  override async workset<R extends WorksetRequest>(request: R): Promise<WorksetResultFor<R>> {
    const result = await super.workset(request);
    if (request.op === "get") {
      const gate = this.getGates.shift();
      if (gate !== undefined) await gate;
    }
    return result;
  }
}

class ProjectClient extends DeferredGetClient {
  readonly projects: ProjectEntry[] = [
    { key: "alpha", displayName: "Alpha" },
    { key: "beta", displayName: "Beta" },
  ];

  async listProjects(): Promise<ProjectEntry[]> {
    return this.projects;
  }
}

class RefreshFailureClient extends FakeClient {
  rejectNextGet = false;

  override async workset<R extends WorksetRequest>(request: R): Promise<WorksetResultFor<R>> {
    const result = await super.workset(request);
    if (request.op === "get" && this.rejectNextGet) {
      this.rejectNextGet = false;
      throw new Error("refresh unavailable");
    }
    return result;
  }
}

describe("ledger-tui workset manager [Behavioral-Active Blackbox-Atomic]", () => {
  it("opens globally, loads once, and renders current roots, nodes, and traced edges", async () => {
    const client = new FakeClient();
    await client.updateItem("tasks", "T1", { fields: { dependsOn: ["T2"] } });
    await client.workset({ op: "set", roots: ["T1"] });
    client.worksetCalls.length = 0;
    const rendered = render(<App client={client} />);
    await tick();

    await press(rendered, "w");
    await waitFor(rendered, "Current traced graph");

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Workset manager");
    expect(frame).toContain("roots: tasks:T1");
    expect(frame).toContain("tasks:T1 -[prerequisite]-> tasks:T2");
    expect(client.worksetCalls).toEqual([{ op: "get", projection: "id" }]);
    rendered.unmount();
  });

  it("hydrates persisted roots before enabling edits or mutation actions", async () => {
    const client = new DeferredGetClient();
    await client.workset({ op: "set", roots: ["T1"] });
    let release = (): void => undefined;
    client.getGates.push(new Promise<void>((resolve) => { release = resolve; }));
    client.worksetCalls.length = 0;
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Editor unavailable until current roots load");

    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    await press(rendered, CTRL_L);
    expect(rendered.lastFrame()).not.toContain("root: T2");
    expect(client.worksetCalls).toEqual([{ op: "get", projection: "id" }]);

    release();
    await waitFor(rendered, "Draft roots:");
    expect(rendered.lastFrame()).toContain("tasks:T1");
    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    expect(rendered.lastFrame()).toContain("T2");
    rendered.unmount();
  });

  it("adds, removes, applies, reloads, and clears the root set", async () => {
    const client = new FakeClient();
    await client.workset({ op: "set", roots: ["T1"] });
    client.worksetCalls.length = 0;
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");

    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    await press(rendered, CTRL_D);
    expect(rendered.lastFrame()).not.toContain("› T2");

    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    await press(rendered, CTRL_A);
    await waitFor(rendered, "Applied epoch 2.");
    expect(rendered.lastFrame()).toContain("roots: tasks:T1, tasks:T2");

    await press(rendered, CTRL_L);
    await waitFor(rendered, "Applied epoch 3.");
    expect(rendered.lastFrame()).toContain("roots: (none)");
    expect(client.worksetCalls.filter(({ op }) => op === "set")).toEqual([
      { op: "set", roots: ["tasks:T1", "T2"] },
      { op: "set", roots: [] },
    ]);
    rendered.unmount();
  });

  it("fetch-previews a draft without mutating current roots", async () => {
    const client = new FakeClient();
    await client.workset({ op: "set", roots: ["T1"] });
    client.worksetCalls.length = 0;
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");
    await typeText(rendered, "T2");
    await press(rendered, CTRL_P);
    await waitFor(rendered, "Preview only; current roots were not changed.");

    expect(rendered.lastFrame()).toContain("Fetch preview");
    expect(client.worksetCalls.filter(({ op }) => op === "set")).toHaveLength(0);
    expect(client.worksetCalls.at(-1)).toEqual({
      op: "fetch",
      roots: ["tasks:T1", "T2"],
      projection: "id",
    });
    rendered.unmount();
  });

  it("shows rejected apply errors while preserving the entered draft", async () => {
    const client = new FakeClient();
    await client.workset({ op: "set", roots: ["T1"] });
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");
    await typeText(rendered, "T-missing");
    await press(rendered, ENTER);
    await press(rendered, CTRL_A);
    await waitFor(rendered, "Error: workset root \"tasks:T-missing\" is inactive");

    expect(rendered.lastFrame()).toContain("T-missing");
    expect(rendered.lastFrame()).toContain("roots: tasks:T1");
    rendered.unmount();
  });

  it("retains the committed canonical acknowledgement when post-set refresh rejects", async () => {
    const client = new RefreshFailureClient();
    await client.workset({ op: "set", roots: ["T1"] });
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");
    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    client.rejectNextGet = true;
    await press(rendered, CTRL_A);
    await waitFor(rendered, "applied at epoch 2; refresh failed: refresh unavailable");

    const frame = rendered.lastFrame() ?? "";
    expect(frame).not.toContain("Current traced graph");
    expect(frame).toContain("tasks:T1");
    expect(frame).toContain("tasks:T2");
    rendered.unmount();
  });

  it("reloads after a same-client project switch and does not reuse the old graph", async () => {
    const client = new ProjectClient();
    await client.workset({ op: "set", roots: ["T1"] });
    client.worksetCalls.length = 0;
    const connectCalls: string[] = [];
    const rendered = render(
      <App
        client={client}
        mcpUrl="http://hub.example/mcp"
        connect={async (url) => {
          connectCalls.push(url);
          return client;
        }}
      />,
    );
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T1");
    await press(rendered, ESC);
    let releaseOldProjectGet = (): void => undefined;
    client.getGates.push(new Promise<void>((resolve) => { releaseOldProjectGet = resolve; }));
    await press(rendered, "w");
    await waitFor(rendered, "Editor unavailable");
    await press(rendered, ESC);
    await client.workset({ op: "set", roots: ["T2"] });
    client.worksetCalls.length = 0;

    await press(rendered, "p");
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await waitFor(rendered, "project: Beta");
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T2");

    expect(connectCalls).toEqual(["http://hub.example/p/beta/mcp"]);
    expect(client.worksetCalls).toEqual([{ op: "get", projection: "id" }]);
    expect(client.closed).toBe(false);
    releaseOldProjectGet();
    await tick(75);
    expect(rendered.lastFrame()).toContain("roots: tasks:T2");
    expect(rendered.lastFrame()).not.toContain("roots: tasks:T1");
    rendered.unmount();
  });

  it("drops a delayed get from a closed overlay after reopen", async () => {
    const client = new DeferredGetClient();
    await client.workset({ op: "set", roots: ["T1"] });
    let releaseOld = (): void => undefined;
    client.getGates.push(new Promise<void>((resolve) => { releaseOld = resolve; }));
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Editor unavailable");
    await press(rendered, ESC);
    await client.workset({ op: "set", roots: ["T2"] });
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T2");

    releaseOld();
    await tick(75);
    expect(rendered.lastFrame()).toContain("roots: tasks:T2");
    expect(rendered.lastFrame()).not.toContain("roots: tasks:T1");
    rendered.unmount();
  });

  it("closes an old overlay when a delayed project connection commits", async () => {
    const clientA = new ProjectClient();
    const clientB = new ProjectClient();
    await clientA.workset({ op: "set", roots: ["T1"] });
    await clientB.workset({ op: "set", roots: ["T2"] });
    clientB.worksetCalls.length = 0;
    let resolveConnect = (_client: FakeClient): void => undefined;
    const pendingConnect = new Promise<FakeClient>((resolve) => { resolveConnect = resolve; });
    const rendered = render(
      <App
        client={clientA}
        mcpUrl="http://hub.example/mcp"
        connect={async () => await pendingConnect}
      />,
    );
    await tick();
    await press(rendered, "p");
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T1");

    resolveConnect(clientB);
    await waitFor(rendered, "project: Beta");
    expect(rendered.lastFrame()).not.toContain("Workset manager");
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T2");
    expect(clientB.worksetCalls).toEqual([{ op: "get", projection: "id" }]);
    rendered.unmount();
  });

  it("drops a delayed post-set reload after close and reopen", async () => {
    const client = new DeferredGetClient();
    await client.workset({ op: "set", roots: ["T1"] });
    const rendered = render(<App client={client} />);
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");
    let releasePostSet = (): void => undefined;
    client.getGates.push(new Promise<void>((resolve) => { releasePostSet = resolve; }));
    await typeText(rendered, "T2");
    await press(rendered, ENTER);
    await press(rendered, CTRL_A);
    await waitFor(rendered, "Request in progress…");
    await press(rendered, ESC);
    await client.workset({ op: "set", roots: ["T2"] });
    await press(rendered, "w");
    await waitFor(rendered, "roots: tasks:T2");

    releasePostSet();
    await tick(75);
    expect(rendered.lastFrame()).toContain("roots: tasks:T2");
    expect(rendered.lastFrame()).not.toContain("roots: tasks:T1, tasks:T2");
    rendered.unmount();
  });

  it("bounds a large graph so editor controls and validation errors remain visible", async () => {
    const client = new FakeClient();
    for (let index = 3; index <= 14; index += 1) {
      await client.createItem("tasks", "M1", {
        id: `T${index}`,
        status: "planned",
        fields: { headline: `large graph task ${index}` },
      });
    }
    await client.workset({ op: "set", roots: ["M1"] });
    const rendered = render(<App client={client} />);
    Object.defineProperty(rendered.stdout, "columns", { value: 72 });
    Object.defineProperty(rendered.stdout, "rows", { value: 18 });
    rendered.stdout.emit("resize");
    await tick();
    await press(rendered, "w");
    await waitFor(rendered, "Draft roots:");
    expect(rendered.lastFrame()).toContain("nodes: 15");
    expect(rendered.lastFrame()).toContain("(+12)");
    expect(rendered.lastFrame()).toContain("Ctrl+A");

    await press(rendered, CTRL_P);
    await waitFor(rendered, "Fetch preview");
    expect(rendered.lastFrame()).toContain("root: ▌");
    expect(rendered.lastFrame()).toContain("Ctrl+A");

    await typeText(rendered, "T-missing");
    await press(rendered, ENTER);
    await press(rendered, CTRL_A);
    await waitFor(rendered, "Error: workset root \"tasks:T-missing\" is inactive");
    expect(rendered.lastFrame()).toContain("root: ▌");
    expect(rendered.lastFrame()).toContain("Ctrl+A");
    rendered.unmount();
  });
});

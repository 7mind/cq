/**
 * D29 — server-enforced precondition on a `questions` item's answer transition.
 *
 * A `questions` item may not transition to `answered` unless the EFFECTIVE
 * answer = (patch.fields?.answer ?? item.fields.answer) is a present,
 * non-whitespace string. Enforced at the LedgerStore layer (via the
 * StatusChangePrecondition hook, mirroring assertGoalPhasePreconditions) so NO
 * client can bypass it.
 *
 * Runs the same assertions against BOTH adapters (FsLedgerStore over a tmp dir,
 * InMemoryLedgerStore dummy) via a per-test factory mirroring
 * goal-preconditions.test.ts (dual-tests).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  serializeRegistry,
  QUESTIONS_LEDGER,
  SchemaValidationError,
  type LedgerStore,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

interface StoreFactory {
  name: string;
  build(): Promise<LedgerStore>;
  teardown(store: LedgerStore): Promise<void>;
}

const dirs: string[] = [];

const fsFactory: StoreFactory = {
  name: "FsLedgerStore",
  async build() {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-q-answer-precond-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: [] }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

const inMemFactory: StoreFactory = {
  name: "InMemoryLedgerStore",
  async build() {
    const store = new InMemoryLedgerStore({ seed: [] });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

/** Create an `open` question (no answer yet); returns its id. */
async function seedOpenQuestion(
  store: LedgerStore,
  milestoneId: string,
): Promise<string> {
  const q = await store.createItem(QUESTIONS_LEDGER, milestoneId, {
    status: "open",
    fields: { question: "why?" },
  });
  return q.id;
}

for (const factory of [fsFactory, inMemFactory]) {
  describe(`question answer precondition (${factory.name})`, () => {
    it("1. rejects answered with an empty-string answer in the patch", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        await expect(
          store.updateItem(QUESTIONS_LEDGER, qid, {
            status: "answered",
            fields: { answer: "" },
          }),
        ).rejects.toThrow(SchemaValidationError);
        // No mutation on the rejected path: the question is still open.
        expect(store.fetchItem(QUESTIONS_LEDGER, qid).status).toBe("open");
      } finally {
        await factory.teardown(store);
      }
    });

    it("2. rejects answered with a whitespace-only answer in the patch", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        await expect(
          store.updateItem(QUESTIONS_LEDGER, qid, {
            status: "answered",
            fields: { answer: "   " },
          }),
        ).rejects.toThrow(SchemaValidationError);
        expect(store.fetchItem(QUESTIONS_LEDGER, qid).status).toBe("open");
      } finally {
        await factory.teardown(store);
      }
    });

    it("3. rejects answered with NO answer present at all (absent field)", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        await expect(
          store.updateItem(QUESTIONS_LEDGER, qid, { status: "answered" }),
        ).rejects.toThrow(SchemaValidationError);
        expect(store.fetchItem(QUESTIONS_LEDGER, qid).status).toBe("open");
      } finally {
        await factory.teardown(store);
      }
    });

    it("4. allows answered when the patch carries a non-empty answer", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        const updated = await store.updateItem(QUESTIONS_LEDGER, qid, {
          status: "answered",
          fields: { answer: "the actual answer" },
        });
        expect(updated.status).toBe("answered");
        expect(updated.fields["answer"]).toBe("the actual answer");
      } finally {
        await factory.teardown(store);
      }
    });

    it("5. allows answered when a non-empty answer is ALREADY on the item (no answer in patch)", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        // Put a non-empty answer on the still-open item first (field-only patch).
        await store.updateItem(QUESTIONS_LEDGER, qid, {
          fields: { answer: "drafted earlier" },
        });
        // Now transition to answered WITHOUT an answer in the patch — the
        // effective answer comes from the item and is non-empty.
        const updated = await store.updateItem(QUESTIONS_LEDGER, qid, {
          status: "answered",
        });
        expect(updated.status).toBe("answered");
        expect(updated.fields["answer"]).toBe("drafted earlier");
      } finally {
        await factory.teardown(store);
      }
    });

    it("6. an empty patch answer overrides a non-empty item answer and is rejected", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        await store.updateItem(QUESTIONS_LEDGER, qid, {
          fields: { answer: "drafted earlier" },
        });
        // The patch explicitly blanks the answer while transitioning — the
        // EFFECTIVE answer is the patch's empty string, so it must be rejected.
        await expect(
          store.updateItem(QUESTIONS_LEDGER, qid, {
            status: "answered",
            fields: { answer: "   " },
          }),
        ).rejects.toThrow(SchemaValidationError);
        expect(store.fetchItem(QUESTIONS_LEDGER, qid).status).toBe("open");
      } finally {
        await factory.teardown(store);
      }
    });

    it("7. withdrawn (not answered) is NOT gated by the answer precondition", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const qid = await seedOpenQuestion(store, m.id);
        // open → withdrawn requires no answer content.
        const updated = await store.updateItem(QUESTIONS_LEDGER, qid, {
          status: "withdrawn",
        });
        expect(updated.status).toBe("withdrawn");
      } finally {
        await factory.teardown(store);
      }
    });
  });
}

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

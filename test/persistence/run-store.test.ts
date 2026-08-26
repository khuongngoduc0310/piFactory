import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelFactoryRun,
  completeFactoryRun,
  createFactoryRun,
  failFactoryRun,
  markNodeCompleted,
  markNodeReady,
  markNodeRunning,
  markFactoryRunWaitingHuman,
  snapshotFactoryRun,
  startFactoryRun,
  updateRunGraph,
  type FactoryRun,
} from "../../src/domain/index.js";
import {
  FileRunStore,
  PersistenceError,
  getRunStorageKey,
} from "../../src/persistence/index.js";
import { createWorkGraph } from "../../src/domain/work-graph.js";
import { createWorkNode } from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";
const T2 = "2026-08-25T10:02:00.000Z";
const T3 = "2026-08-25T10:03:00.000Z";
const T4 = "2026-08-25T10:04:00.000Z";
const T5 = "2026-08-25T10:05:00.000Z";

const directories: string[] = [];

function makeRun(id = "run-1"): FactoryRun {
  return createFactoryRun({
    id,
    request: "Implement persistence",
    tier: "fast",
    graph: createWorkGraph([
      createWorkNode(
        {
          id: "build",
          objective: "Implement the request",
          role: "builder",
          builderMode: "implement",
          dependsOn: [],
          scope: {},
          acceptanceCriteria: ["Targeted checks pass"],
          risk: "low",
          complexity: "small",
          parallelSafe: false,
        },
        T0,
      ),
    ]),
    budget: { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 1 },
    createdAt: T0,
  });
}

function completedRun(): FactoryRun {
  const running = startFactoryRun(makeRun(), T1);
  let graph = markNodeReady(running.graph, "build", T2);
  graph = markNodeRunning(graph, "build", T3);
  graph = markNodeCompleted(graph, "build", T4, {
    artifactRefs: ["artifact-build"],
    outputDigest: "sha256:output",
  });
  return completeFactoryRun(updateRunGraph(running, graph, T4), T5);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pifactory-phase2-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("FileRunStore", () => {
  it("round-trips every FactoryRun status through a fresh store", async () => {
    const root = await temporaryDirectory();
    const statuses: readonly FactoryRun[] = [
      makeRun("created"),
      startFactoryRun(makeRun("running"), T1),
      markFactoryRunWaitingHuman(startFactoryRun(makeRun("waiting"), T1), T2),
      failFactoryRun(startFactoryRun(makeRun("failed"), T1), T2, "Failure"),
      cancelFactoryRun(makeRun("cancelled"), T1),
      completedRun(),
    ];

    for (const run of statuses) {
      const store = new FileRunStore({ storageRoot: root });
      const created = await store.create(run, [
        {
          id: `created-${run.id}`,
          timestamp: T0,
          type: "factory_run_created",
          payload: { status: run.status },
        },
      ]);
      const restored = await new FileRunStore({ storageRoot: root }).load(run.id);

      expect(restored.run).toEqual(run);
      expect(restored.stateVersion).toBe(1);
      expect(restored.events).toEqual(created.events);
    }
  });

  it("preserves completed node history and allows further domain operations", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });
    const created = await store.create(completedRun());
    const restored = await new FileRunStore({ storageRoot: root }).load("run-1");
    const node = restored.run.graph.nodes[0];

    expect(created.stateVersion).toBe(1);
    expect(node?.status).toBe("completed");
    expect(node?.outputDigest).toBe("sha256:output");
    expect(node?.artifactRefs).toEqual(["artifact-build"]);
    expect(node?.executionHistory.map(({ status }) => status)).toEqual([
      "pending",
      "ready",
      "running",
      "completed",
    ]);
    expect(Object.isFrozen(restored.run.graph.nodes[0]?.executionHistory)).toBe(true);
    expect(() => snapshotFactoryRun(restored.run)).not.toThrow();
  });

  it("publishes a new saved state and rejects stale writers", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });
    await store.create(makeRun(), [
      { id: "created", timestamp: T0, type: "factory_run_created", payload: {} },
    ]);
    const running = startFactoryRun(makeRun(), T1);
    const saved = await store.save(running, 1, [
      { id: "started", timestamp: T1, type: "factory_run_started", payload: {} },
    ]);

    expect(saved.stateVersion).toBe(2);
    expect(saved.run.status).toBe("running");
    expect(saved.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    await expect(
      store.save(running, 1, [{ id: "stale", timestamp: T2, type: "node_started", payload: {} }]),
    ).rejects.toMatchObject({ code: "stale_state_version" });
  });

  it("serializes overlapping saves within a process", async () => {
    const root = await temporaryDirectory();
    const firstStore = new FileRunStore({ storageRoot: root });
    const secondStore = new FileRunStore({ storageRoot: root });
    await firstStore.create(makeRun());

    const results = await Promise.allSettled([
      firstStore.save(startFactoryRun(makeRun(), T1), 1),
      secondStore.save(cancelFactoryRun(makeRun(), T1), 1),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.code : undefined).toBe(
      "stale_state_version",
    );
  });

  it("leaves the previous saved state current when publication fails", async () => {
    const root = await temporaryDirectory();
    let failPublication = false;
    const store = new FileRunStore({
      storageRoot: root,
      hooks: {
        beforeCurrentPublish: () => {
          if (failPublication) {
            throw new PersistenceError("io_failure", "Injected publication failure");
          }
        },
      },
    });
    await store.create(makeRun(), [
      { id: "created", timestamp: T0, type: "factory_run_created", payload: {} },
    ]);
    failPublication = true;

    await expect(
      store.save(startFactoryRun(makeRun(), T1), 1, [
        { id: "started", timestamp: T1, type: "factory_run_started", payload: {} },
      ]),
    ).rejects.toMatchObject({ code: "io_failure" });

    const restored = await new FileRunStore({ storageRoot: root }).load("run-1");
    expect(restored.stateVersion).toBe(1);
    expect(restored.run.status).toBe("created");
    expect(restored.events.map(({ id }) => id)).toEqual(["created"]);
  });

  it("ignores unpublished state directories", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });
    await store.create(makeRun());
    const statesDirectory = join(root, "runs", getRunStorageKey("run-1"), "states");
    await writeFile(join(statesDirectory, ".pending-unpublished"), "not a state directory");

    const loaded = await store.load("run-1");

    expect(loaded.stateVersion).toBe(1);
  });

  it("fails closed when the current saved state directory is missing", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });
    await store.create(makeRun());
    const runDirectory = join(root, "runs", getRunStorageKey("run-1"));
    const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
      stateDirectory: string;
    };
    await rm(join(runDirectory, "states", current.stateDirectory), {
      recursive: true,
      force: true,
    });

    await expect(store.load("run-1")).rejects.toMatchObject({ code: "corrupt_state" });
  });

  it("rejects malformed, mismatched, and unsupported persisted data", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });
    await store.create(makeRun());
    const runDirectory = join(root, "runs", getRunStorageKey("run-1"));
    const currentPath = join(runDirectory, "current.json");
    const current = JSON.parse(await readFile(currentPath, "utf8")) as {
      stateDirectory: string;
    };
    const runPath = join(runDirectory, "states", current.stateDirectory, "run.json");
    const original = await readFile(runPath, "utf8");

    await writeFile(runPath, "{ malformed");
    await expect(store.load("run-1")).rejects.toMatchObject({ code: "corrupt_state" });
    await writeFile(runPath, original);

    const runDocument = JSON.parse(original) as { state: { status: string } };
    runDocument.state.status = "completed";
    await writeFile(runPath, JSON.stringify(runDocument));
    await expect(store.load("run-1")).rejects.toMatchObject({ code: "corrupt_state" });
    await writeFile(runPath, original);

    await writeFile(currentPath, JSON.stringify({ ...current, schemaVersion: 99 }));
    await expect(store.load("run-1")).rejects.toMatchObject({ code: "unsupported_schema" });
  });

  it("does not use unsafe raw IDs as storage paths", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({ storageRoot: root });

    await expect(store.load("..\\outside")).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(join(root, "runs")).catch(() => [])).toEqual([]);
  });

  it("enforces bounded event payloads before creating a saved state", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({
      storageRoot: root,
      limits: { maxEventPayloadBytes: 8 },
    });

    await expect(
      store.create(makeRun(), [
        {
          id: "large",
          timestamp: T0,
          type: "factory_run_created",
          payload: { value: "too large" },
        },
      ]),
    ).rejects.toMatchObject({ code: "size_limit_exceeded" });
  });

  it("enforces serialized run limits before replacing the current saved state", async () => {
    const root = await temporaryDirectory();
    const store = new FileRunStore({
      storageRoot: root,
      limits: { maxRunFileBytes: 1_024 },
    });
    await store.create(makeRun());
    const oversized = {
      ...startFactoryRun(makeRun(), T1),
      request: "x".repeat(2_000),
    };

    await expect(store.save(oversized, 1)).rejects.toMatchObject({
      code: "size_limit_exceeded",
    });
    const loaded = await store.load("run-1");
    expect(loaded.stateVersion).toBe(1);
    expect(loaded.run.status).toBe("created");
  });

  it("rejects a symlinked run directory", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const runsDirectory = join(root, "runs");
    await mkdirForTest(runsDirectory);
    await symlink(outside, join(runsDirectory, getRunStorageKey("run-1")), "junction");

    await expect(new FileRunStore({ storageRoot: root }).load("run-1")).rejects.toMatchObject({
      code: "unsafe_storage_entry",
    });
  });
});

async function mkdirForTest(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

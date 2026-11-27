import assert from "node:assert/strict"
import { test } from "node:test"
import {
  InMemoryProjectionCheckpointStore,
  createMemoryRecord,
  projectAndStore,
  runProjector,
  type MemoryRecord,
  type ProjectionContext,
  type ProjectionEvent,
  type Projector,
} from "../src/index.ts"

function event(id: string, type = "task.completed"): ProjectionEvent {
  return {
    id,
    type,
    occurredAt: "2026-11-17T10:00:00Z",
    source: { kind: "task_result", ref: id },
    payload: { taskId: id },
  }
}

function makeProjector(): Projector {
  return {
    name: "task-summary",
    sourceKind: "task_result",
    supports: (candidate) => candidate.type === "task.completed",
    project: (candidate) => [
      createMemoryRecord({
        id: `mem-${candidate.id}`,
        scope: "project",
        ownerId: "user-1",
        projectId: "proj-1",
        kind: "task_summary",
        title: `任务 ${candidate.id}`,
        text: `完成了 ${candidate.id}`,
        source: { kind: "task_result", ref: candidate.id },
      }),
    ],
  }
}

test("runs a projector and skips unsupported events", async () => {
  const report = await runProjector(
    makeProjector(),
    [event("a"), event("b", "other"), event("c")],
    { scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" }, now: "2026-11-17T10:00:00Z" },
  )
  assert.equal(report.processed, 3)
  assert.equal(report.skipped, 1)
  assert.equal(report.projected, 2)
  assert.deepEqual(report.issues, [])
})

test("deduplicates records emitted twice in one batch", async () => {
  const projector = makeProjector()
  const report = await runProjector(projector, [event("a"), event("a")], {
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
    now: "2026-11-17T10:00:00Z",
  })
  assert.equal(report.projected, 1)
  assert.equal(report.records.length, 1)
})

test("reports a projector failure without aborting the batch", async () => {
  const projector: Projector = {
    ...makeProjector(),
    project: (candidate) => {
      if (candidate.id === "bad") throw new Error("boom")
      return []
    },
  }
  const report = await runProjector(projector, [event("bad"), event("ok")], {
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
    now: "2026-11-17T10:00:00Z",
  })
  assert.equal(report.issues.length, 1)
  assert.match(report.issues[0] ?? "", /boom/)
  assert.equal(report.processed, 2)
})

const runContext: ProjectionContext = {
  scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
  now: "2026-11-17T10:00:00Z",
}

class CollectingSink {
  batches: MemoryRecord[][] = []

  async upsertMany(records: readonly MemoryRecord[]): Promise<void> {
    this.batches.push([...records])
  }
}

test("projects, writes and advances the checkpoint once", async () => {
  const sink = new CollectingSink()
  const checkpoints = new InMemoryProjectionCheckpointStore()
  const first = await projectAndStore(
    makeProjector(),
    [event("a"), event("b")],
    runContext,
    sink,
    { checkpointStore: checkpoints },
  )
  assert.equal(first.written, 2)
  assert.equal(first.checkpoint?.lastEventId, "b")
  assert.equal(sink.batches.length, 1)

  const second = await projectAndStore(
    makeProjector(),
    [event("a"), event("b")],
    runContext,
    sink,
    { checkpointStore: checkpoints },
  )
  assert.equal(second.written, 0)
  assert.equal(sink.batches.length, 1)

  const third = await projectAndStore(
    makeProjector(),
    [event("a"), event("b"), event("c")],
    runContext,
    sink,
    { checkpointStore: checkpoints },
  )
  assert.equal(third.written, 1)
  assert.equal(third.checkpoint?.lastEventId, "c")
})

test("does not advance the checkpoint when the projector reports issues", async () => {
  const sink = new CollectingSink()
  const checkpoints = new InMemoryProjectionCheckpointStore()
  const failing: Projector = {
    ...makeProjector(),
    project: (candidate) => {
      if (candidate.id === "bad") throw new Error("boom")
      return makeProjector().project(candidate, runContext) as MemoryRecord[]
    },
  }
  const report = await projectAndStore(failing, [event("bad")], runContext, sink, {
    checkpointStore: checkpoints,
  })
  assert.equal(report.issues.length, 1)
  assert.equal(report.checkpoint, undefined)
  assert.equal(await checkpoints.get(failing.name), null)
})

test("does not advance the checkpoint when the sink write fails", async () => {
  const checkpoints = new InMemoryProjectionCheckpointStore()
  const sink = {
    upsertMany: async (): Promise<void> => {
      throw new Error("write failed")
    },
  }
  await assert.rejects(
    projectAndStore(makeProjector(), [event("a")], runContext, sink, { checkpointStore: checkpoints }),
    /write failed/,
  )
  assert.equal(await checkpoints.get("task-summary"), null)
})

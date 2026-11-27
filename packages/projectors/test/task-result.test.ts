import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProjectionContext, ProjectionEvent } from "@agent-rag/core"
import { TaskResultProjector } from "../src/index.ts"

const context: ProjectionContext = {
  scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
  now: "2026-11-17T10:00:00Z",
}

function event(overrides: Partial<ProjectionEvent> = {}): ProjectionEvent {
  return {
    id: "event-1",
    type: "task.completed",
    occurredAt: "2026-11-17T10:00:00Z",
    source: { kind: "task_result", ref: "task-1" },
    payload: {
      taskId: "task-1",
      projectId: "proj-1",
      goal: "给端口读取加环境变量优先",
      summary: "修改了配置读取顺序，测试通过。",
      status: "completed",
      changedFiles: ["src/config.ts", "test/config.test.ts"],
      tests: { command: "pnpm test", passed: true, summary: "12 passed" },
      items: [
        {
          kind: "convention",
          title: "端口优先级",
          text: "PORT 环境变量优先于配置文件默认值。",
          tags: ["config"],
        },
        {
          kind: "issue",
          title: "旧配置兼容",
          text: "旧版 PORT_FILE 仍需要兼容，后续任务不要删除。",
        },
      ],
    },
    ...overrides,
  }
}

test("projects a task result into a summary plus extracted project knowledge", () => {
  const records = new TaskResultProjector().project(event(), context)
  assert.equal(records.length, 3)

  const summary = records.find((record) => record.kind === "task_summary")
  assert.equal(summary?.projectId, "proj-1")
  assert.match(summary?.text ?? "", /测试：pnpm test → 通过/)
  assert.equal(summary?.facts?.["testsPassed"], true)
  assert.equal(summary?.facts?.["changedFileCount"], 2)
  assert.deepEqual(summary?.tags, ["task-summary", "completed"])

  const convention = records.find((record) => record.kind === "convention")
  assert.equal(convention?.title, "端口优先级")
  assert.deepEqual(convention?.tags, ["task", "config"])
})

test("summary id is stable for the same task", () => {
  const projector = new TaskResultProjector()
  const first = projector.project(event(), context)
  const second = projector.project(
    event({
      id: "event-2",
      occurredAt: "2026-11-18T10:00:00Z",
      payload: {
        ...(event().payload as object),
        summary: "补充了测试。",
      },
    }),
    context,
  )
  const firstSummary = first.find((record) => record.kind === "task_summary")
  const secondSummary = second.find((record) => record.kind === "task_summary")
  assert.equal(firstSummary?.id, secondSummary?.id)
  assert.notEqual(firstSummary?.checksum, secondSummary?.checksum)
})

test("rejects a project id outside the projection scope", () => {
  assert.throws(
    () =>
      new TaskResultProjector().project(
        event({
          payload: {
            taskId: "task-1",
            projectId: "proj-2",
            goal: "x",
            summary: "y",
            status: "completed",
          },
        }),
        context,
      ),
    /does not match/,
  )
})

test("rejects a user-scope context", () => {
  assert.throws(
    () =>
      new TaskResultProjector().project(event(), {
        scope: { scope: "user", ownerId: "user-1" },
        now: "2026-11-17T10:00:00Z",
      }),
    /project-scope/,
  )
})

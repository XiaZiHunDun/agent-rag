import assert from "node:assert/strict"
import { test } from "node:test"
import {
  InMemoryProjectionCheckpointStore,
  createMemoryRecord,
  type ProjectionEvent,
} from "@agent-rag/core"
import { ButlerSessionProjector, TaskResultProjector } from "@agent-rag/projectors"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { AgentRagClient } from "../src/index.ts"

const userContext = {
  scope: { scope: "user" as const, ownerId: "user-1" },
  now: "2026-11-17T10:00:00Z",
}
const projectContext = {
  scope: { scope: "project" as const, ownerId: "user-1", projectId: "proj-1" },
  now: "2026-11-17T10:00:00Z",
}

const butlerEvent: ProjectionEvent = {
  id: "butler-1",
  type: "butler.session.summarized",
  occurredAt: "2026-11-17T10:00:00Z",
  source: { kind: "butler_session", ref: "session-1" },
  payload: {
    userId: "user-1",
    sessionId: "session-1",
    summary: "用户确认了发布分支约定。",
    profile: { communicationStyle: "先结论后细节", preferences: ["用要点回答"] },
    facts: [
      { title: "发布分支", text: "发布分支固定为 release。", kind: "convention", tags: ["release"] },
    ],
  },
}

const taskEvent: ProjectionEvent = {
  id: "task-1",
  type: "task.completed",
  occurredAt: "2026-11-17T10:00:00Z",
  source: { kind: "task_result", ref: "task-1" },
  payload: {
    taskId: "task-1",
    projectId: "proj-1",
    goal: "给端口读取加环境变量优先",
    summary: "修改了配置读取顺序，测试通过。",
    status: "completed",
    changedFiles: ["src/config.ts"],
    tests: { command: "pnpm test", passed: true },
    items: [
      {
        kind: "convention",
        title: "端口优先级",
        text: "PORT 环境变量优先于配置文件默认值。",
        tags: ["config"],
      },
    ],
  },
}

function makeClient() {
  const store = new InMemoryTextStore()
  const client = new AgentRagClient({
    store,
    checkpointStore: new InMemoryProjectionCheckpointStore(),
    projectors: [new ButlerSessionProjector(), new TaskResultProjector()],
  })
  return { store, client }
}

test("projects butler and task memory into isolated scopes", async () => {
  const { client } = makeClient()

  const butler = await client.project("butler-session", [butlerEvent], userContext)
  assert.equal(butler.written, 2)

  const task = await client.project("task-result", [taskEvent], projectContext)
  assert.equal(task.written, 2)
  assert.equal((await client.stats()).total, 4)

  const userHits = await client.recall({
    scope: userContext.scope,
    text: "发布分支",
    limit: 5,
  })
  assert.ok(userHits.length >= 1)
  assert.ok(userHits.every((hit) => hit.record.scope === "user"))
  assert.ok(userHits.some((hit) => hit.record.kind === "convention"))

  const projectHits = await client.recall({
    scope: projectContext.scope,
    text: "端口",
    limit: 5,
  })
  assert.ok(projectHits.length >= 1)
  assert.ok(projectHits.every((hit) => hit.record.scope === "project"))

  const leak = await client.recall({ scope: userContext.scope, text: "端口", limit: 5 })
  assert.equal(leak.length, 0)
})

test("re-projecting the same events is a no-op", async () => {
  const { client } = makeClient()
  await client.project("butler-session", [butlerEvent], userContext)
  const second = await client.project("butler-session", [butlerEvent], userContext)
  assert.equal(second.written, 0)
  assert.equal((await client.stats()).total, 2)
})

test("manual remember and forget use the same scope rules", async () => {
  const { client } = makeClient()
  const manual = createMemoryRecord({
    scope: "user",
    ownerId: "user-1",
    kind: "preference",
    title: "回复长度",
    text: "默认控制在三句话内。",
    source: { kind: "manual", ref: "owner-edit-1" },
  })
  await client.remember(manual)
  assert.equal((await client.get(manual.id))?.title, "回复长度")

  const deleted = await client.forget({ scope: "user", ownerId: "user-1" })
  assert.equal(deleted, 1)
  assert.equal((await client.stats()).total, 0)
})

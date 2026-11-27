import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentRagClient } from "@agent-rag/client"
import { InMemoryProjectionCheckpointStore } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createWfxmTaskMemory } from "../src/index.ts"

function setup() {
  const store = new InMemoryTextStore()
  const client = new AgentRagClient({
    store,
    checkpointStore: new InMemoryProjectionCheckpointStore(),
  })
  const memory = createWfxmTaskMemory({
    client,
    ownerId: "user-1",
    clock: () => "2026-11-17T10:00:00Z",
  })
  return { store, memory }
}

test("projects a task outcome into project memory", async () => {
  const { memory, store } = setup()
  await memory.recordTaskOutcome({
    taskId: "task-1",
    projectId: "proj-1",
    goal: "给登录接口加限流",
    summary: "在 gateway 增加令牌桶，默认 10 rps。",
    status: "completed",
    changedFiles: ["src/gateway/limiter.ts"],
    tests: { command: "pnpm test", passed: true },
    occurredAt: "2026-11-17T10:00:00Z",
  })

  const hits = await store.search({
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
    text: "限流",
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.kind, "task_summary")
  assert.equal(hits[0]?.record.facts?.testsPassed, true)
  assert.match(hits[0]?.record.text ?? "", /改动了|改动文件|令牌桶/)
})

test("keeps the latest turn for the same task instead of duplicating", async () => {
  const { memory, store } = setup()
  await memory.recordTaskOutcome({
    taskId: "task-1",
    projectId: "proj-1",
    goal: "给登录接口加限流",
    summary: "第一轮：先加配置项。",
    status: "partial",
    occurredAt: "2026-11-17T10:00:00Z",
  })
  await memory.recordTaskOutcome({
    taskId: "task-1",
    projectId: "proj-1",
    goal: "给登录接口加限流",
    summary: "第二轮：限流已上线。",
    status: "completed",
    occurredAt: "2026-11-17T11:00:00Z",
  })

  const hits = await store.search({
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
    text: "限流",
  })
  assert.equal(hits.length, 1)
  assert.match(hits[0]?.record.text ?? "", /限流已上线/)
  assert.equal(hits[0]?.record.facts?.status, "completed")
})

test("keeps project memory isolated between projects", async () => {
  const { memory, store } = setup()
  await memory.recordTaskOutcome({
    taskId: "task-1",
    projectId: "proj-1",
    goal: "修复登录超时",
    summary: "超时时间从 30s 调到 60s。",
    status: "completed",
    occurredAt: "2026-11-17T10:00:00Z",
  })

  const other = await store.search({
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-2" },
    text: "登录",
  })
  assert.equal(other.length, 0)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentRagClient } from "@agent-rag/client"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createWfxmMemoryPorts } from "../src/wfxm-ports.ts"

test("wires both memory domains onto one client", async () => {
  const client = new AgentRagClient({ store: new InMemoryTextStore() })
  const memory = createWfxmMemoryPorts({
    client,
    ownerId: "user-1",
    clock: () => "2026-11-17T10:00:00.000Z",
  })

  await memory.butler.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "用户希望我多用中文。",
    profile: { preferences: ["中文回复"] },
    occurredAt: "2026-11-17T10:00:00.000Z",
  })
  await memory.task.recordTaskOutcome({
    taskId: "t1",
    projectId: "p1",
    goal: "修登录超时",
    summary: "调整了网关超时配置。",
    status: "completed",
    occurredAt: "2026-11-17T10:00:00.000Z",
  })

  const profile = await memory.butler.recallUserMemory?.("中文")
  assert.ok(profile && profile.length > 0)

  const hits = await client.recall({
    scope: { scope: "project", ownerId: "user-1", projectId: "p1" },
    text: "网关超时",
  })
  assert.ok(hits.some((hit) => hit.record.kind === "task_summary"))
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InMemoryProjectRegistry } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createMcpServer } from "../src/mcp-server.ts"
import { AgentRagService } from "../src/service.ts"

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as readonly { type: string; text?: string }[]
  return content.map((block) => block.text ?? "").join("\n")
}

test("mcp server exposes memory tools and shares the service state", async () => {
  const service = new AgentRagService({
    store: new InMemoryTextStore(),
    registry: new InMemoryProjectRegistry(),
    defaultOwnerId: "user-1",
    defaultClient: "mcp-test",
  })
  const project = await service.resolveProject({
    remoteUrl: "git@github.com:XiaZiHunDun/agent-rag.git",
  })
  await service.remember({
    ownerId: "user-1",
    kind: "preference",
    title: "回复风格",
    text: "先结论，后细节。",
  })

  const server = createMcpServer({
    service,
    defaultOwnerId: "user-1",
    defaultProjectId: project.projectId,
    defaultClient: "mcp-test",
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: "test-client", version: "0.0.0" })
  await client.connect(clientTransport)

  try {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      "memory_context",
      "memory_recall",
      "memory_remember",
      "memory_report_session",
      "memory_report_task",
      "memory_stats",
      "project_resolve",
    ])

    const context = await client.callTool({
      name: "memory_context",
      arguments: { goal: "发布分支" },
    })
    assert.ok(textOf(context).includes("## 用户记忆"))

    const reported = await client.callTool({
      name: "memory_report_task",
      arguments: {
        taskId: "task-mcp-1",
        goal: "发布准备",
        summary: "补充发布脚本。",
        status: "completed",
        items: [{ kind: "convention", title: "发布分支", text: "固定使用 release 分支。" }],
      },
    })
    const report = JSON.parse(textOf(reported)) as { projectId: string; written: number }
    assert.equal(report.projectId, project.projectId)
    assert.ok(report.written >= 2)

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: { text: "发布分支" },
    })
    const hits = JSON.parse(textOf(recall)) as { title: string }[]
    assert.ok(hits.some((hit) => hit.title === "发布分支"))

    const stats = await client.callTool({ name: "memory_stats", arguments: {} })
    const parsed = JSON.parse(textOf(stats)) as { total: number }
    assert.ok(parsed.total >= 3)
  } finally {
    await client.close()
    await server.close()
  }
})

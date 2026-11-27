import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { AgentRagHttpClient } from "@agent-rag/client"
import { InMemoryProjectRegistry } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createHttpServer } from "../src/http-server.ts"
import { createMcpServer } from "../src/mcp-server.ts"
import { AgentRagService } from "../src/service.ts"

const TOKEN = "test-token"

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as readonly { type: string; text?: string }[]
  return content.map((block) => block.text ?? "").join("\n")
}

async function startSharedService(): Promise<{
  baseUrl: string
  service: AgentRagService
  close(): Promise<void>
}> {
  const service = new AgentRagService({
    store: new InMemoryTextStore(),
    registry: new InMemoryProjectRegistry(),
    defaultOwnerId: "user-1",
    defaultClient: "http-test",
  })
  const server = createHttpServer({ service, token: TOKEN })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    service,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("mcp --remote writes through the shared HTTP service", async () => {
  const shared = await startSharedService()
  const http = new AgentRagHttpClient({
    baseUrl: shared.baseUrl,
    token: TOKEN,
    ownerId: "user-1",
    client: "remote-mcp",
  })

  try {
    const project = await http.resolveProject({
      remoteUrl: "git@github.com:XiaZiHunDun/agent-rag.git",
    })

    const server = createMcpServer({
      service: http,
      defaultOwnerId: "user-1",
      defaultProjectId: project.projectId,
      defaultClient: "remote-mcp",
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const client = new Client({ name: "remote-test", version: "0.0.0" })
    await client.connect(clientTransport)

    try {
      const remembered = await client.callTool({
        name: "memory_remember",
        arguments: {
          kind: "convention",
          title: "远程共享",
          text: "多个助手通过同一个 HTTP 服务共享记忆。",
        },
      })
      const record = JSON.parse(textOf(remembered)) as {
        id: string
        projectId?: string
        source: { client: string }
      }
      assert.equal(record.projectId, project.projectId)
      assert.equal(record.source.client, "remote-mcp")

      // The write must be visible to the in-process service, proving the MCP
      // server does not hold its own store snapshot.
      const hits = await shared.service.recall({
        ownerId: "user-1",
        projectId: project.projectId,
        text: "远程共享",
      })
      assert.ok(hits.some((hit) => hit.record.id === record.id))

      const context = await client.callTool({
        name: "memory_context",
        arguments: { goal: "共享记忆" },
      })
      assert.ok(textOf(context).includes("远程共享"))

      const stats = await client.callTool({ name: "memory_stats", arguments: {} })
      const parsed = JSON.parse(textOf(stats)) as { total: number }
      assert.ok(parsed.total >= 1)
    } finally {
      await client.close()
      await server.close()
    }
  } finally {
    await shared.close()
  }
})

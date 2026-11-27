import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { AgentRagHttpClient } from "@agent-rag/client"
import { InMemoryProjectRegistry } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createHttpServer } from "../src/http-server.ts"
import { AgentRagService } from "../src/service.ts"

interface RunningServer {
  readonly baseUrl: string
  readonly service: AgentRagService
  close(): Promise<void>
}

async function startServer(token?: string): Promise<RunningServer> {
  const service = new AgentRagService({
    store: new InMemoryTextStore(),
    registry: new InMemoryProjectRegistry(),
    defaultOwnerId: "user-1",
    defaultClient: "test",
  })
  const server = createHttpServer({
    service,
    ...(token === undefined ? {} : { token }),
  })
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

test("two assistants share user and project memory through one server", async () => {
  const app = await startServer()
  try {
    const wfxm = new AgentRagHttpClient({
      baseUrl: app.baseUrl,
      ownerId: "user-1",
      client: "wfxm",
    })
    const dsh = new AgentRagHttpClient({
      baseUrl: app.baseUrl,
      ownerId: "user-1",
      client: "dsh-wfxm",
    })

    const fromWfxm = await wfxm.resolveProject({
      remoteUrl: "git@github.com:XiaZiHunDun/agent-rag.git",
      localPath: "/home/u/wfxm-clone",
    })
    const fromDsh = await dsh.resolveProject({
      remoteUrl: "https://github.com/xiazihundun/agent-rag",
      localPath: "/home/u/projects/agent-rag",
    })
    assert.equal(fromWfxm.projectId, fromDsh.projectId)

    await wfxm.remember({
      scope: "user",
      kind: "preference",
      title: "回复风格",
      text: "先结论，后细节。",
    })
    await wfxm.reportSession({
      sessionId: "session-1",
      summary: "用户确认了发布约定。",
      profile: { preferences: ["中文回复"] },
    })
    await wfxm.reportTask({
      projectId: fromWfxm.projectId,
      taskId: "task-1",
      goal: "发布准备",
      summary: "补充了发布脚本，测试通过。",
      status: "completed",
      items: [
        { kind: "convention", title: "发布分支", text: "固定使用 release 分支。" },
      ],
    })
    await dsh.reportTask({
      project: { remoteUrl: "https://github.com/xiazihundun/agent-rag" },
      taskId: "task-2",
      goal: "回滚配置",
      summary: "补充了回滚说明。",
      status: "completed",
      items: [{ kind: "convention", title: "回滚方式", text: "使用上一版 release 包。" }],
    })

    const projectHits = await dsh.recall({
      projectId: fromWfxm.projectId,
      text: "发布",
      limit: 10,
    })
    assert.ok(projectHits.some((hit) => hit.record.title === "发布分支"))
    assert.ok(projectHits.some((hit) => hit.record.facts?.["status"] === "completed"))

    const rollbackHits = await dsh.recall({
      projectId: fromWfxm.projectId,
      text: "回滚",
      limit: 10,
    })
    assert.ok(rollbackHits.some((hit) => hit.record.facts?.["taskId"] === "task-2"))
    assert.ok(rollbackHits.some((hit) => hit.record.source.client === "dsh-wfxm"))

    const context = await dsh.inject({
      projectId: fromWfxm.projectId,
      goal: "发布分支",
    })
    assert.ok(context.text.includes("## 用户记忆"))
    assert.ok(context.text.includes("## 项目记忆"))
    assert.ok(context.text.includes("发布分支"))
    assert.ok(context.userHits.some((hit) => hit.record.kind === "preference"))

    const stats = await dsh.stats()
    assert.ok(stats.total >= 6)
    assert.equal((await dsh.listProjects()).length, 1)
    assert.equal((await dsh.health()).ok, true)
  } finally {
    await app.close()
  }
})

test("health stays public while other endpoints require the token", async () => {
  const app = await startServer("secret-token")
  try {
    const health = await fetch(`${app.baseUrl}/health`)
    assert.equal(health.status, 200)

    const unauthorized = await fetch(`${app.baseUrl}/v1/stats`)
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`${app.baseUrl}/v1/stats`, {
      headers: { authorization: "Bearer secret-token" },
    })
    assert.equal(authorized.status, 200)
    const body = (await authorized.json()) as { total: number }
    assert.equal(typeof body.total, "number")
  } finally {
    await app.close()
  }
})

test("rejects invalid requests and forgets only the target scope", async () => {
  const app = await startServer()
  try {
    const invalid = await fetch(`${app.baseUrl}/v1/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerId: "user-1", kind: "note", text: "missing title" }),
    })
    assert.equal(invalid.status, 400)

    const client = new AgentRagHttpClient({ baseUrl: app.baseUrl, ownerId: "user-1" })
    const project = await client.resolveProject({ name: "demo" })
    await client.remember({ scope: "user", kind: "note", title: "用户事实", text: "用户记忆" })
    await client.remember({
      scope: "project",
      projectId: project.projectId,
      kind: "note",
      title: "项目事实",
      text: "项目记忆",
    })

    assert.equal(await client.forget({}), 1)
    assert.equal((await client.recall({ text: "记忆" })).length, 0)
    assert.equal((await client.recall({ projectId: project.projectId, text: "记忆" })).length, 1)
  } finally {
    await app.close()
  }
})

# 助手集成指南

agent-rag 支持三种接入方式，同一份数据可同时被多个助手读写。

## 0. 统一约定

| 项 | 建议 |
| --- | --- |
| `ownerId` | 所有助手配置同一个稳定 id，如 `user_me`；这是跨助手复用用户记忆的关键 |
| `client` | 各助手填入自己的名字（`wfxm`、`dsh-wfxm`、`cli`），写入记录会带 `source.client` |
| 项目 | 优先传 `remoteUrl`；只传 `localPath` 时服务端会读取 `.git/config` 的 origin |
| 数据目录 | 共享同一台机器时所有助手指向同一个 `--data-dir`；跨机用 HTTP 模式 |

## 1. 嵌入式（WFXM 现有方式）

与 Node 同进程时直接使用 SDK，无需起服务：

```ts
import { AgentRagClient } from "@agent-rag/client"
import { JsonTextStore } from "@agent-rag/store-text"
import { createWfxmMemoryPorts } from "@agent-rag/adapters"

const store = await JsonTextStore.open("/home/me/.agent-rag/memory.json")
const client = new AgentRagClient({ store })

const memory = createWfxmMemoryPorts({
  client,
  ownerId: "user_me",
  clock: () => new Date().toISOString(),
})

// 组装层注入 WFXM 自己的端口
createButlerAssembly({ butlerMemory: memory.butler, taskMemory: memory.task })
```

WFXM 的 butler 会话会投影成用户画像/偏好/承诺；任务结果会投影成项目任务摘要与抽取知识。

需要注入上下文时：

```ts
const context = await client.inject({
  ownerId: "user_me",
  projectId: "prj_…",
  goal: "修复登录超时",
  files: ["src/gateway/timeout.ts"],
})
const systemPrompt = context.text ? `${context.text}\n\n${basePrompt}` : basePrompt
```

## 2. MCP（dsh-wfxm、IDE Agent）

启动 MCP server（每个助手进程一个，或多个助手共用一个服务时改用 HTTP）：

```bash
node /path/to/agent-rag/packages/server/src/cli.ts mcp \
  --owner user_me \
  --client dsh-wfxm \
  --project /path/to/repo
```

客户端配置：

```json
{
  "mcpServers": {
    "agent-rag": {
      "command": "node",
      "args": [
        "/path/to/agent-rag/packages/server/src/cli.ts",
        "mcp",
        "--owner", "user_me",
        "--client", "dsh-wfxm",
        "--project", "/path/to/repo"
      ]
    }
  }
}
```

> `--project` 只影响默认项目；助手在处理其他仓库时可显式传 `project` 参数或调用 `project_resolve`。

助手侧推荐流程：

```text
会话开始
  → memory_context({ goal, files })
  → 将返回文本作为 <agent-rag-memory> 注入 system prompt

执行中
  → 发现明确约定/决策时 memory_remember({ kind, title, text })

任务结束
  → memory_report_task({ taskId, goal, summary, status, items })

画像变化
  → memory_report_session({ sessionId, summary, profile, facts })
```

注意事项：

- `memory_context` 返回空文本表示没有相关记忆，直接跳过注入。
- 不要把原始对话、完整 diff、日志作为 `text`；只写结论，一条一个事实。
- `secret` 敏感级默认不会被召回或注入。

## 3. HTTP（多助手共享、跨语言）

```bash
node /path/to/agent-rag/packages/server/src/cli.ts serve \
  --owner user_me \
  --port 8787 \
  --token "$AGENT_RAG_TOKEN"
```

其他助手用 HTTP 客户端：

```ts
import { AgentRagHttpClient } from "@agent-rag/client"

const rag = new AgentRagHttpClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.AGENT_RAG_TOKEN,
  ownerId: "user_me",
  client: "dsh-wfxm",
})

const project = await rag.resolveProject({ localPath: process.cwd() })
const context = await rag.inject({ projectId: project.projectId, goal: "发布分支怎么走" })
await rag.reportTask({
  projectId: project.projectId,
  taskId: "task-123",
  goal: "修复登录超时",
  summary: "调整网关超时配置，测试通过。",
  status: "completed",
  items: [{ kind: "convention", title: "网关超时", text: "固定 30s，由 GATEWAY_TIMEOUT_MS 控制。" }],
})
```

任意语言也可直接调 HTTP 接口，见 [api.md](api.md)。

## 多端复用的工作机制

1. 项目：`remoteUrl` 规范化为 `host/owner/repo` → `projectId = prj_ + sha256(key)[0:16]`。
   - `git@github.com:Owner/Repo.git`、`https://github.com/owner/repo`、`ssh://git@github.com:22/owner/repo` 归一到同一个 key。
   - 只给本地路径时，服务端读取 `.git/config`（含 worktree 的 `gitdir:` 指针）补全 origin。
   - 因此 WFXM 和 dsh-wfxm 即使 clone 在不同目录，也共享同一份项目记忆。
2. 用户：所有助手配置同一个 `ownerId`，即可共享画像、偏好、承诺。
3. 幂等：同一任务/会话重复上报使用稳定 id 覆盖，不会产生重复记忆。

## 排障

| 现象 | 检查 |
| --- | --- |
| `owner is required` | 传 `--owner` 或设置 `AGENT_RAG_OWNER_ID` |
| MCP 无响应/协议错乱 | 确保 MCP 模式下 stdout 只输出协议（CLI 日志走 stderr）；不要用 `console.log` 调试 |
| 项目记忆为空 | `project_resolve` 看 `projectId` 是否一致；检查各助手是否传了同一 remote |
| 两个 clone 得到不同 projectId | 本地 `.git/config` 没有 origin，或使用了不同 fork 的 remote |
| 401 | HTTP 服务设置了 `--token`，客户端需带 `Authorization: Bearer` |
| 找不到 `.ts` 模块 | Node 版本需 ≥ 22.18（推荐 24）；低版本需加 `--experimental-strip-types` |

# agent-rag

个人开发助手的长期记忆库：把用户画像、偏好、项目约定、决策和任务结论沉淀下来，供任意开发助手（WFXM、dsh-wfxm、IDE Agent）**召回**与**注入**。多个助手共用同一份数据，换助手不用重新介绍自己和项目。

## 能力

- **用户 + 项目两级记忆**：user scope 存画像/偏好/承诺，project scope 存约定/决策/任务结论，严格隔离。
- **注入（injection）**：一次调用返回可直接拼进 system prompt 的 `<agent-rag-memory>` 文本块，带常驻画像、按目标召回、字符预算与截断标记。
- **召回（recall）**：BM25 文本检索，标题加权、中文单字+二元组、标签与结构化 facts；支持按 kind / tag / 置信度过滤，并可显式包含过期或 `secret` 记录。
- **多端共建**：项目身份由 git remote 解析为稳定 `projectId`，不同 clone、不同助手落到同一项目；用户身份由统一的 `ownerId` 指定。
- **三种接入**：MCP stdio、HTTP JSON API、嵌入式 SDK（现有 WFXM 适配层）。
- **可替换存储**：内存、JSON 文件（原子写）、Postgres（`tsvector`）共用同一 `TextMemoryStore` 契约。
- **幂等投影**：会话/任务事件投影成结论，稳定 id + checkpoint，重复上报不产生重复记忆。

## 快速开始

要求 Node.js ≥ 22.18（原生运行 TypeScript），推荐 Node 24。

```bash
pnpm install
pnpm test          # 114 个测试
pnpm typecheck
```

### 作为 MCP server 接入助手

```bash
node packages/server/src/cli.ts mcp \
  --owner user_me \
  --client dsh-wfxm \
  --project /path/to/current-repo
```

MCP 客户端配置示例：

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
        "--project", "/path/to/current-repo"
      ]
    }
  }
}
```

暴露的工具：

| 工具 | 用途 |
| --- | --- |
| `memory_context` | 会话开始时取注入文本（goal + 文件列表） |
| `memory_recall` | 按关键词检索 user / project 记忆 |
| `memory_remember` | 保存一条明确结论 |
| `memory_report_task` | 任务结束后上报目标、摘要、状态与抽取的项目知识 |
| `memory_report_session` | 上报会话摘要、画像字段与显式事实 |
| `project_resolve` | remote / 路径 / 名称 → 稳定 projectId |
| `memory_stats` | 记忆规模统计 |

### 作为 HTTP 服务运行

```bash
node packages/server/src/cli.ts serve --owner user_me --port 8787
# 跨机部署时加 --token <token>，请求需携带 Authorization: Bearer <token>
```

```bash
curl -s http://127.0.0.1:8787/v1/context \
  -H 'content-type: application/json' \
  -d '{"goal":"发布分支怎么走","projectId":"prj_xxx"}'
```

接口明细见 [docs/api.md](docs/api.md)。

生产环境推荐只跑一个共享 `serve` 进程，助手侧 MCP 用远程模式接入：

```bash
# 1) 共享服务：单进程持有 memory.json，避免多进程快照互相覆盖
node packages/server/src/cli.ts serve --owner user_me --host 127.0.0.1 --port 8787 \
  --token "$AGENT_RAG_TOKEN"

# 2) 助手侧 MCP 不再持有本地数据，只做 HTTP 转发
node packages/server/src/cli.ts mcp \
  --remote http://127.0.0.1:8787 \
  --token "$AGENT_RAG_TOKEN" \
  --owner user_me --client dsh-wfxm --project /path/to/repo
```

`--remote` 也可用 `AGENT_RAG_REMOTE`，`--token` 可用 `AGENT_RAG_TOKEN`。远程模式下 `--project`
先在本机读取 git remote，再向服务端换取同一个 `projectId`。

### 命令行

CLI 命令一览见 docs/api.md。

```bash
agent-rag resolve --remote-url git@github.com:owner/repo.git
agent-rag remember --owner user_me --kind preference --title 回复风格 --text "先结论，后细节。"
agent-rag inject --owner user_me --project . --goal "修复登录超时"
agent-rag recall --owner user_me --project . 发布
agent-rag recall --owner user_me --project . 发布 \
  --kind convention --kind decision --tag release --min-confidence 0.5
agent-rag recall --owner user_me --include-sensitive --include-expired
agent-rag stats
agent-rag forget --owner user_me --project . --yes
```

数据默认保存在 `~/.agent-rag/`（`AGENT_RAG_HOME` 可覆盖）：

```
~/.agent-rag/
├── memory.json     # 记忆记录
└── projects.json   # 项目身份与别名
```

## 多端共建数据

1. 用户在各助手里配置同一个 `--owner user_me`。
2. 各助手用当前仓库的路径或 git remote 调用 `project_resolve`；服务端会自动读取本地 `.git/config` 的 origin，把不同 clone 归一到同一个 `projectId`。
3. 任务结束调用 `memory_report_task`，项目知识进入 project scope；会话结束调用 `memory_report_session`，画像与偏好进入 user scope。
4. 任一助手在会话开始时调用 `memory_context`，即可拿到其他助手沉淀的用户与项目记忆。

```text
WFXM（/home/u/wfxm-clone）─┐
                           ├─ project_resolve(remote) → prj_ab12… → 同一份项目记忆
dsh-wfxm（/home/u/agent-rag）┘
```

## 设计文档

- [架构设计](docs/architecture.md)：数据模型、作用域、投影、注入、身份解析、存储演进。
- [HTTP / MCP API](docs/api.md)：请求响应字段与错误码。
- [助手集成](docs/integration.md)：嵌入式、MCP、HTTP 三种接入方式与排障。

## 隐私与安全

- 默认只监听 `127.0.0.1`；跨机访问必须配置 token。
- `sensitivity=secret` 的记忆默认不召回、不注入。
- 不做遥测，不向第三方发送数据；仓库本身不包含任何用户数据。
- 支持按作用域 `forget` 整段删除。

## 状态

当前 `0.1.0`：文本检索、单用户、任务/会话投影、MCP/HTTP/嵌入式接入已可用；维护能力已交付 `stats --by-source`、`purge --expired`、`export/import`、`forget --source`。后续计划：向量混合检索与 rerank、SQLite FTS5 适配、多用户鉴权与审计。

## License

[MIT](LICENSE)

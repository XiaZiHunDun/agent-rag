# HTTP 与 MCP API

服务默认地址 `http://127.0.0.1:8787`。设置 `--token` 后，除 `/health` 外所有请求必须带：

```
Authorization: Bearer <token>
```

响应均为 JSON；错误格式为 `{ "error": "message" }`。请求体上限 1 MB。

## HTTP

### GET /health

无需鉴权。

```json
{ "ok": true, "name": "agent-rag", "version": "0.1.0", "total": 42 }
```

### POST /v1/projects/resolve

```json
{ "remoteUrl": "git@github.com:owner/repo.git", "localPath": "/path/to/repo", "name": "repo" }
```

三个字段至少一个；只给 `localPath` 时服务端会读取 `.git/config` 的 origin。

```json
{
  "project": {
    "projectId": "prj_ab12cd34ef56ab78",
    "key": "git:github.com/owner/repo",
    "name": "repo",
    "remoteUrl": "git@github.com:owner/repo.git",
    "aliases": ["git:github.com/owner/repo", "path:/path/to/repo"],
    "createdAt": "2026-11-27T00:00:00.000Z",
    "updatedAt": "2026-11-27T00:00:00.000Z"
  }
}
```

### GET /v1/projects

```json
{ "projects": [ /* ProjectIdentity[] */ ] }
```

### POST /v1/context

召回用户 + 项目记忆并渲染注入块。

请求：

```json
{
  "ownerId": "user_me",
  "projectId": "prj_ab12cd34ef56ab78",
  "goal": "修复登录超时",
  "files": ["src/gateway/timeout.ts"],
  "maxChars": 2500,
  "includeSensitive": false
}
```

响应：

```json
{
  "text": "<agent-rag-memory>\n…\n</agent-rag-memory>",
  "entries": [
    {
      "id": "…",
      "scope": "project",
      "kind": "convention",
      "title": "发布分支",
      "text": "固定使用 release 分支。",
      "score": 4.2,
      "confidence": 0.9,
      "source": { "kind": "task_result", "ref": "task-1", "client": "wfxm" },
      "updatedAt": "2026-11-27T00:00:00.000Z"
    }
  ],
  "usedChars": 312,
  "truncated": false,
  "userHits": [ /* MemoryHit[] */ ],
  "projectHits": [ /* MemoryHit[] */ ]
}
```

### POST /v1/recall

```json
{
  "ownerId": "user_me",
  "projectId": "prj_…",
  "text": "发布",
  "limit": 10,
  "kinds": ["convention", "decision"],
  "tags": ["release"],
  "minConfidence": 0.5,
  "includeSensitive": false,
  "includeExpired": false
}
```

不传 `projectId` 时检索 user scope，传入则检索 project scope。响应 `{ "hits": MemoryHit[] }`。

### POST /v1/remember

```json
{
  "ownerId": "user_me",
  "scope": "project",
  "projectId": "prj_…",
  "kind": "convention",
  "title": "发布分支",
  "text": "固定使用 release 分支。",
  "facts": { "branch": "release" },
  "tags": ["release"],
  "confidence": 0.9,
  "sensitivity": "normal",
  "client": "dsh-wfxm"
}
```

`scope` 省略时按是否传 `projectId` 推断。响应 `{ "record": MemoryRecord }`。

### POST /v1/tasks/report

```json
{
  "ownerId": "user_me",
  "projectId": "prj_…",
  "taskId": "task-123",
  "goal": "修复登录超时",
  "summary": "调整网关超时配置，测试通过。",
  "status": "completed",
  "changedFiles": ["src/gateway/timeout.ts"],
  "tests": { "command": "pnpm test", "passed": true },
  "items": [
    {
      "kind": "convention",
      "title": "网关超时",
      "text": "网关超时固定 30s，由 GATEWAY_TIMEOUT_MS 控制。",
      "tags": ["gateway"]
    }
  ],
  "client": "dsh-wfxm",
  "occurredAt": "2026-11-27T00:00:00.000Z"
}
```

`projectId` 可省略，改用 `"project": { "localPath": "/path/to/repo" }` 或 `"project": { "remoteUrl": "…" }`。响应：

```json
{ "projectId": "prj_…", "written": 2, "recordIds": ["…"], "issues": [] }
```

### POST /v1/sessions/report

```json
{
  "ownerId": "user_me",
  "sessionId": "session-1",
  "summary": "用户确认发布分支固定为 release。",
  "profile": {
    "displayName": "小王",
    "communicationStyle": "先结论后细节",
    "preferences": ["中文回复"],
    "commitments": ["本周只做稳定性修复"]
  },
  "facts": [
    { "kind": "relationship", "title": "同事小李", "text": "负责发布审批。" }
  ],
  "client": "dsh-wfxm"
}
```

响应同任务上报（无 `projectId`）。

### POST /v1/forget

```json
{ "ownerId": "user_me", "projectId": "prj_…" }
```

省略 `projectId` 时删除整个 user scope；响应 `{ "deleted": 3 }`。该接口只支持
整域删除；按来源撤销记忆请使用 CLI 的 `forget --source <client>`，按 id 删除
单条记录请使用 CLI 的 `forget --id <id>`。

### GET /v1/stats

```json
{
  "total": 42,
  "byScope": { "user\u0000user_me\u0000": 10, "project\u0000user_me\u0000prj_…": 32 },
  "byKind": { "note": 30, "decision": 12 },
  "bySource": { "wfxm": 25, "dsh-wfxm": 14, "unknown": 3 }
}
```

`bySource` 按 `source.client` 聚合；缺失或空白 `source.client` 的记录计入 `unknown`。

### 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数或记录校验失败 |
| 401 | 未带 token 或 token 错误 |
| 404 | 路径不存在 |
| 405 | 方法不支持 |
| 413 | 请求体过大 |
| 500 | 内部错误（详情只写服务端日志） |

## MCP 工具

MCP server 通过 `agent-rag mcp --owner <id>` 启动，`--project <path>` 可设置默认项目。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `memory_context` | `goal?`, `files?`, `projectId?`, `maxChars?` | 注入文本块（无命中时提示 no relevant memory） |
| `memory_recall` | `text`, `scope?`, `projectId?`, `limit?`, `kinds?`, `includeSensitive?` | 命中列表 JSON |
| `memory_remember` | `kind`, `title`, `text`, `scope?`, `projectId?`, `facts?`, `tags?`, `confidence?`, `sensitivity?` | 新记录 JSON |
| `memory_report_task` | `taskId`, `goal`, `summary`, `status`, `projectId?`, `project?`, `changedFiles?`, `tests?`, `items?` | `{ projectId, written, recordIds, issues }` |
| `memory_report_session` | `sessionId`, `summary`, `profile?`, `facts?` | `{ written, recordIds, issues }` |
| `project_resolve` | `remoteUrl?`, `localPath?`, `name?` | `ProjectIdentity` |
| `memory_stats` | 无 | `{ total, byScope, byKind, bySource }` |

推荐的助手侧调用顺序：

1. 会话开始：`memory_context({ goal })`，把返回文本拼进 system prompt。
2. 执行中遇到明确约定/决策：`memory_remember(...)`。
3. 任务结束：`memory_report_task(...)`，把结论沉淀到项目作用域。
4. 用户画像有变化：`memory_report_session(...)`。

## CLI

命令行入口为 `agent-rag <command>`（仓库内可直接
`node packages/server/src/cli.ts <command>`）。除 `version` 外，通用选项包括
`--data-dir <dir>`、`--store json|memory`、`--owner <id>` 等；本地默认读写
`~/.agent-rag/`（可用 `AGENT_RAG_HOME` 覆盖）。

| 命令 | 说明 |
| --- | --- |
| `version [--json]` | 打印版本号 |
| `resolve` | 把仓库路径 / git remote 解析为稳定 `projectId` |
| `remember` | 写入一条记忆 |
| `recall [query]` | 按作用域召回 |
| `inject` | 生成可注入的上下文块 |
| `stats [--by-kind] [--by-source]` | 输出记录计数 |
| `export --out <path>` | 把 store 中全部记录导出为 JSONL |
| `import --in <path>` | 从 JSONL 按 id 幂等导入 |
| `forget [--id <id>] [--source <client>] [--dry-run] [--yes]` | 删除整个作用域、按来源撤销，或按 id 删除单条记忆（`--id` 与 `--source` 互斥） |
| `purge --expired [--dry-run] [--yes]` | 删除 `validTo` 已过期的记录（跨作用域） |

### `stats [--by-kind] [--by-source]`

默认只输出 `total` 与 `byScope`。`--by-kind` 追加 `byKind`，`--by-source` 追加
`bySource`，两个选项可以同时使用。

`bySource` 按 `source.client` 聚合记录数；缺失或空白 `source.client` 的记录统一
归入 `unknown`。空库输出 `total: 0` 与空的 `bySource` 对象。

```bash
agent-rag stats --by-source
agent-rag stats --by-kind --by-source
```

```json
{
  "total": 3,
  "byScope": { "user\u0000user_me\u0000": 1, "project\u0000user_me\u0000prj_ab12": 2 },
  "bySource": { "wfxm": 2, "unknown": 1 }
}
```

### `export --out <path>`

导出 store 中的**全部**记忆记录，不区分 user / project 作用域，也不过滤
`secret` 或已过期记录。文件为 JSONL：每行一个完整的 `MemoryRecord` JSON
对象，记录按 `id` 排序，文件以换行结尾；没有记录时生成空文件。

```bash
agent-rag export --out ~/agent-rag-backup.jsonl
agent-rag export --data-dir /srv/agent-rag --out /tmp/memory.jsonl
```

目标文件已存在时默认拒绝覆盖并以非 0 退出；确认覆盖需加 `--force`。

```bash
agent-rag export --out ~/agent-rag-backup.jsonl --force
```

成功时输出 `{ "exported": N, "out": "..." }`（JSON）。

### `import --in <path>`

逐行读取 JSONL，每条记录先做完整校验，再按 `id` 执行 upsert：

- 相同 `id` 重复导入只会更新同一条记录，不会产生重复数据；
- 文件内同一 `id` 出现多次时，后面的行覆盖前面的行；
- 空行忽略；
- 任意一行非法（JSON 解析失败或字段校验失败）时，以
  `第 N 行: 原因` 报错并以非 0 退出，**整批不写入**（N 为原始 1-based 行号）。

```bash
agent-rag import --in ~/agent-rag-backup.jsonl
```

成功时输出 `{ "imported": N, "in": "..." }`（JSON）。导入不校验记录是否属于当前
`--owner`，备份中的 `ownerId` / `projectId` 原样保留，便于跨机器迁移。

### `forget`

三种模式（`--id` 与 `--source` 互斥）：

- **整域删除**（原有语义）：不带 `--id` / `--source` 时，按 `--project` /
  `--project-id` 选择 project scope，否则删除 user scope；`--owner` 必填，
  实际删除需要 `--yes`；带 `--dry-run` 时只预览匹配条数，不写入。
- **按来源撤销**：带 `--source <client>` 时，删除 `source.client` 严格等于
  `<client>` 的全部记录，跨 user / project scope，不按 `owner` 或 `project`
  过滤。
- **按 id 删除**：带 `--id <id>` 时，删除 id 严格等于 `<id>` 的单条记录。
  id 全局唯一，因此不要求 `--owner`，也不按 `--project` 或 scope 过滤。

按来源撤销时：

- 未带 `--yes` 只预览匹配条数，不写入；
- `--dry-run` 即使同时带 `--yes` 也只预览，不写入；
- 只删除 `source.client` 等于目标的记录；`source.client` 不同或缺失的记录
  保持不变；
- 没有匹配记录时输出 `matched: 0`、`deleted: 0`，退出码仍为 0。

成功时输出 `{ "source": "...", "matched": N, "deleted": M, "dryRun": true|false }`
（JSON）。`matched` 是匹配条数，`deleted` 是实际删除条数；预览时
`deleted` 为 0。

按 id 删除时：

- 未带 `--yes` 只预览，不写入；
- `--dry-run` 即使同时带 `--yes` 也只预览，永不写入；
- 只删除 id 完全相等的记录，其他记录保持不变；
- 指定 id 不存在时打印 `memory not found: <id>` 并以退出码 1 结束；
- 成功时输出 `{ "id": "...", "matched": 1, "deleted": 0|1, "dryRun": true|false }`
  （JSON）。预览时 `deleted` 为 0。

```bash
# 按来源预览 / 删除
agent-rag forget --source wfxm
agent-rag forget --source wfxm --yes
# 按来源显式 dry-run
agent-rag forget --source wfxm --dry-run --yes
# 按 id 预览 / 删除
agent-rag forget --id mem_abc123
agent-rag forget --id mem_abc123 --yes
# 按 id 显式 dry-run
agent-rag forget --id mem_abc123 --dry-run --yes
```

### `purge --expired`

维护命令，用于清理已经过期的记忆：删除 `validTo` 早于或等于当前时间的记录，
**不区分 user / project scope**，也不按 `owner` 或 `project` 过滤。

- `--expired` 必填；未带该选项时命令报错并以非 0 退出。
- 未带 `--yes` 时只预览匹配/删除条数，不写入。
- `--dry-run` 即使同时带 `--yes` 也只预览，永不写入。
- 没有 `validTo` 的记录和尚未过期的记录都会保留。
- 没有匹配记录时输出 `matched: 0`、`deleted: 0`，退出码仍为 0。

成功时输出 `{ "matched": N, "deleted": M, "dryRun": true|false }`（JSON）。
`matched` 是匹配条数，`deleted` 是实际删除条数；预览时 `deleted` 为 0。

```bash
# 预览
agent-rag purge --expired
# 实际删除
agent-rag purge --expired --yes
# 显式 dry-run
agent-rag purge --expired --dry-run --yes
```

### export / import 快速示例

三条常用命令：

```bash
# 1) 导出全部记录（目标文件不存在时创建）
agent-rag export --out ~/agent-rag-backup.jsonl

# 2) 从备份按 id 幂等导入（先整批校验，失败则不写入）
agent-rag import --in ~/agent-rag-backup.jsonl

# 3) 目标文件已存在时显式覆盖（注意：--force 只属于 export）
agent-rag export --out ~/agent-rag-backup.jsonl --force
```

命令成功时分别输出 `{ "exported": N, "out": "..." }` 与
`{ "imported": N, "in": "..." }`（JSON）。

JSONL 每一行是一个完整的 `MemoryRecord` JSON 对象：记录按 `id` 排序，一行一条，
文件以换行结尾。每行的关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 记录唯一 id；导入时按它幂等 upsert，相同 `id` 只更新同一条 |
| `schemaVersion` | 记录结构版本，当前固定为 `1` |
| `scope` | `user` 或 `project` |
| `ownerId` | 所属用户；project scope 下为工作区/租户 owner |
| `projectId` | project scope 必填；user scope 必须省略 |
| `kind` | `profile` / `preference` / `relationship` / `commitment` / `decision` / `convention` / `recipe` / `issue` / `task_summary` / `note` |
| `title` / `text` | 标题（≤200 字符）与可检索正文（≤20000 字符） |
| `source` | 来源对象，至少含 `kind`、`ref`，可选 `client`、`version`、`excerpt` |
| `confidence` | 0..1 的置信度 |
| `sensitivity` | `normal` / `private` / `secret` |
| `createdAt` / `updatedAt` | ISO 时间 |
| `validFrom` / `validTo` | 可选有效期（ISO 时间） |
| `facts` / `tags` / `supersedes` / `checksum` | 可选：结构化槽位、标签、被替代记录 id、内容校验和 |

导入时每行都必须是完整合法记录：空行忽略；任意一行非法（JSON 解析失败或字段
校验失败）会以 `第 N 行: 原因` 报错并以非 0 退出，**整批不写入**。导入不按
`--owner` 过滤，备份中的 `ownerId` / `projectId` 原样保留，便于跨机器迁移。

## 错误码与排查

### 退出码

CLI 进程的退出码约定如下：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功。命令正常完成；未带 `--yes` 或带 `--dry-run` 的预览类命令也属于成功。 |
| `1` | 执行失败。CLI 捕获到错误后，在 stderr 以 `[agent-rag] ` 前缀输出原因，并把退出码置为 1。参数缺失/非法、未知命令、记录不存在、JSONL 校验失败、文件或目录无权限等目前都归入这一档。 |
| `2` | 用法错误（预留档位）。约定用于未知命令、未知选项、缺少必填参数等“调用方式不对”的情况，便于脚本把它和运行期失败区分开。 |

> 当前 `0.1.0` 实现中，用法错误与运行期错误一样由入口的 `main().catch` 统一设为
> 退出码 `1`，`2` 这一档尚未启用。脚本若需要严格区分两类失败，请同时检查 stderr
> 文本（例如 `unknown command:`、`Unknown option` 等）。

### 常见错误信息

除 `version`、`--help` 等直接输出到 stdout 的命令外，错误信息统一写到 stderr，
格式为 `[agent-rag] <原因>`。下表按常见程度列出：

| 错误信息（stderr） | 常见原因 | 排查 / 处理 |
| --- | --- | --- |
| `memory not found: <id>` | `forget --id <id>` 指定的记录不存在。 | id 全局唯一，先确认 id 没有多余空白；再用 `agent-rag stats` 或 `agent-rag export --out <path>` 核对记录是否在预期的 store 中。注意 `--data-dir`、`--store`、`AGENT_RAG_HOME` 是否指向同一份数据。 |
| `第 N 行: <原因>`（invalid JSONL） | `import --in <path>` 的 JSONL 第 N 行不是合法 JSON，或缺少/写错必填字段。 | N 是原始文件中的 1-based 行号，空行会被跳过但行号仍按原文件计算。修正该行，或重新 `export` 生成备份后再导入。校验在写入前完成，失败时整批不写入。 |
| `EACCES: permission denied, open '<path>'` | 数据目录、导出目标或导入源文件没有读写权限。 | 检查路径属主与权限（`ls -l`、`namei -l <path>`）；确保 CLI 运行用户与数据目录属主一致，避免用 `sudo` 运行后留下 root 属主的文件；必要时修正 `chmod` / `chown`。 |
| `refusing to overwrite existing file: <path> (use --force)` | `export --out` 的目标文件已存在。 | 换一个输出路径，或确认后加 `--force` 覆盖；`--force` 只属于 `export`。 |
| `owner is required: pass --owner <id> or set AGENT_RAG_OWNER_ID` | 命令需要 owner，但没有传 `--owner`。 | 补 `--owner <id>`，或设置 `AGENT_RAG_OWNER_ID`；多助手复用时所有助手应使用同一个 owner。 |
| `unknown command: <cmd>` | 子命令拼写错误，或把选项放在了命令位置。 | `agent-rag --help` 查看命令列表；命令必须是第一个参数，例如 `agent-rag stats --by-source`。 |
| `Unknown option '--x'` / `Option '--x' argument missing` | 选项名拼错，或需要值的选项没有跟值。 | 对照 `agent-rag --help`；含空格的值要加引号；以 `-` 开头的参数可放在 `--` 之后作为位置参数。 |
| `export requires --out <path>` / `import requires --in <path>` / `purge requires --expired` | 缺少该子命令的必填选项。 | 补齐对应选项；`forget` 未带 `--id` / `--source` 时按整域删除处理，需要 `--owner` 与 `--yes`。 |
| `forget accepts either --id or --source, not both` | 同时传了互斥选项。 | 按 id 删单条用 `--id`，按来源撤销用 `--source`，二选一。 |
| `refusing to delete memory without --yes` | 整域删除未带确认。 | 先用 `--dry-run` 预览匹配条数，确认后加 `--yes`。 |

### 排查顺序

1. **看 stderr 与退出码**：先读 `[agent-rag]` 开头的那一行；不要只看 stdout，
   很多错误不会输出 JSON。
2. **确认作用域**：检查 `--owner`、`--project` / `--project-id` 是否与写入时一致；
   项目记忆为空时先用 `agent-rag resolve` 核对 `projectId`。
3. **确认数据位置**：默认 `~/.agent-rag/`，`--data-dir` 与 `AGENT_RAG_HOME` 可覆盖；
   `--store memory` 是进程内存储，进程结束即丢失，排查“写完就没了”时先确认是否
   误用了内存 store。
4. **先备份再导入/删除**：`export --out` 生成 JSONL 备份；`import` 按 id 幂等，
   非法行会让整批回滚；`forget` / `purge` 先用 `--dry-run` 预览，再加 `--yes`。
5. **HTTP 侧看状态码**：`400` 参数/记录校验失败、`401` token 缺失或错误、`404`
   路径不存在、`405` 方法不支持、`413` 请求体超过 1 MB、`500` 内部错误（详情只写
   服务端日志）。HTTP 响应体形如 `{ "error": "message" }`。
6. **MCP 侧不要污染 stdout**：MCP 模式下 stdout 只跑协议，日志和错误都走 stderr；
   自定义调试输出请用 `console.error`，否则会出现“无响应/协议错乱”。

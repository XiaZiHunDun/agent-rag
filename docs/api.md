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

省略 `projectId` 时删除整个 user scope；响应 `{ "deleted": 3 }`。

### GET /v1/stats

```json
{ "total": 42, "byScope": { "user\u0000user_me\u0000": 10, "project\u0000user_me\u0000prj_…": 32 }, "byKind": { "note": 30, "decision": 12 } }
```

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
| `memory_stats` | 无 | `{ total, byScope, byKind }` |

推荐的助手侧调用顺序：

1. 会话开始：`memory_context({ goal })`，把返回文本拼进 system prompt。
2. 执行中遇到明确约定/决策：`memory_remember(...)`。
3. 任务结束：`memory_report_task(...)`，把结论沉淀到项目作用域。
4. 用户画像有变化：`memory_report_session(...)`。

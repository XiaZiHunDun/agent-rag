# agent-rag 架构设计

## 1. 定位

agent-rag 是**个人开发助手的长期记忆库**：

- 以「用户 + 项目」为作用域，沉淀画像、偏好、约定、决策、任务结论等可复用知识；
- 为任意开发助手（WFXM、dsh-wfxm、未来的 CLI / IDE 插件）提供统一的**召回**与**注入**能力；
- 多个助手通过同一份数据共建、共享记忆，切换助手时无需重新构建个人信息与项目信息。

非目标：

- 不做会话原文存储、diff/日志归档 —— 这些留在各助手自己的存储里；
- 不做 SaaS 多租户计费、不做托管向量数据库；
- 不自动猜测用户身份（避免把两个人的数据误合并）。

## 2. 设计原则

| 原则 | 含义 |
| --- | --- |
| 数据归属用户 | 默认本地单用户部署；每条记录带 source 与 client 归因，可审计、可删除 |
| 作用域硬隔离 | user scope 与 project scope 严格不跨读；越界写入直接拒绝 |
| 结论入库 | projector 把运行时事件投影成结论，禁止把原始对话/diff 直灌 |
| 幂等 | 稳定 id + checkpoint：重复上报、重放事件不产生重复记忆 |
| 多端共建 | 项目身份由 git remote 等稳定锚点解析，换助手/换目录仍落到同一 projectId |
| 可演进 | schemaVersion 显式；新能力以可选字段和可插拔检索扩展 |

## 3. 分层

```
┌─────────────────────────────────────────────────────────────┐
│ 接入层    MCP stdio server │ HTTP JSON API │ 嵌入式 SDK      │
├─────────────────────────────────────────────────────────────┤
│ 应用层    AgentRagService / AgentRagClient                   │
│           召回 recall · 注入 inject · 记忆 remember          │
│           任务上报 reportTask · 会话上报 reportSession       │
├─────────────────────────────────────────────────────────────┤
│ 投影层    ButlerSessionProjector · TaskResultProjector       │
│           （可扩展：自定义 Projector）                        │
├─────────────────────────────────────────────────────────────┤
│ 核心层    MemoryRecord 模型 · 作用域 · 检索契约 · 注入构建    │
├─────────────────────────────────────────────────────────────┤
│ 存储层    InMemoryTextStore · JsonTextStore · PostgresTextStore│
│ 身份层    User ownerId · ProjectRegistry（项目身份与别名）    │
└─────────────────────────────────────────────────────────────┘
```

## 4. 数据模型

一条记忆是一个 `MemoryRecord`：

| 字段 | 说明 |
| --- | --- |
| `id` | 投影记录用 `stableMemoryId` 生成（跨重放稳定）；手工记录可指定 |
| `schemaVersion` | 当前为 1；破坏性变更才升级 |
| `scope` | `user` / `project` |
| `ownerId` | 数据归属用户（user scope 即用户本人；project scope 为项目数据归属人） |
| `projectId` | 仅 project scope 必填，且必须来自 `ProjectRegistry` 解析 |
| `kind` | profile / preference / relationship / commitment / decision / convention / recipe / issue / task_summary / note |
| `title` / `text` | 短标题（检索加权 3 倍）+ 规范化结论文本，禁止原文直灌 |
| `facts` | 结构化槽位（string/number/boolean/null），供程序消费 |
| `tags` | 标签，参与检索 |
| `source` | `{ kind, ref, version?, client?, excerpt? }`，client 记录由哪个助手贡献 |
| `confidence` | 0..1，低置信记录不覆盖明确事实 |
| `sensitivity` | `normal` / `private` / `secret`；`secret` 默认不召回 |
| `validFrom` / `validTo` | 有效期；过期记录默认不召回 |
| `supersedes` | 本记录取代的旧记录 id；写入后由 `retireSupersededRecords` 关闭旧记录有效期 |
| `checksum` | title + text + facts 的稳定哈希，用于跨端去重 |
| `createdAt` / `updatedAt` | ISO 时间 |

## 5. 作用域与权限

- **user scope**：`ownerId` 必填，`projectId` 必须省略。
- **project scope**：`ownerId`（数据归属人）+ `projectId` 都必填。
- 读写严格匹配（scope + ownerId + projectId 三元组）；`forget` 只删除目标作用域。
- 跨作用域 `supersedes` 被拒绝，一个作用域不能废止另一个作用域的记录。
- `secret` 记录默认不进入召回与注入，必须显式 `includeSensitive`。

## 6. 项目身份解析（多端复用的关键）

不同助手可能在不同目录、用不同名称打开同一个仓库。agent-rag 用 `ProjectRegistry` 把它们收敛到同一个 `projectId`：

**定位锚点优先级**

1. `remoteUrl`：规范化为 `host/owner/repo`（去 userinfo、默认端口、`.git`、尾部斜杠；GitHub/Gitee/GitLab 等大小写不敏感主机统一小写）。
2. `localPath`：解析为绝对路径。
3. `name`：小写化名称。

**规则**

- 别名形如 `git:github.com/xiazihundun/agent-rag`、`path:/home/u/projects/agent-rag`、`name:agent-rag`；
- `projectId = "prj_" + sha256(主别名)[0:16]`，确定性、可离线计算；
- 最强定位锚点优先（remote > path > name）：命中该锚点即复用身份，并把未绑定的弱别名并入；
- 弱别名已被其他项目占用时不抢占（先绑定者优先），避免同名仓库被误合并；
- 只给 `localPath` 时，服务层读取 `.git/config` 的 origin（兼容 worktree 的 `gitdir:` 指针）后再解析；
- 注册表持久化在 `projects.json`（与记忆库同目录）。

**效果**：WFXM 在 `/home/u/wfxm-clone`、dsh-wfxm 在 `/home/u/projects/agent-rag`，只要 `git remote` 相同，就落到同一 `projectId`，任务结论、约定、决策自动共享。

## 7. 用户身份

- `ownerId` 由用户统一配置一次（例如 `user_xiazihundun`），各助手启动时通过 `--user` / `AGENT_RAG_OWNER_ID` 注入。
- 不做邮箱、平台账号的自动映射；确需合并时由用户显式指定，避免误合并隐私数据。

## 8. 写入路径

```
runtime event (task completed / session summarized / manual)
        │
        ▼
Projector.project(event, context)         # 纯函数，产出 MemoryRecord[]
        │
        ▼
projectAndStore: 去重 → upsertMany → checkpoint
        │
        ▼
retireSupersededRecords                  # 关闭被取代记录的 validTo
```

- **会话投影**（butler/assistant session）：产出用户画像 + 显式事实（偏好、承诺、关系、约定），用户作用域。
- **任务投影**（task result）：产出任务摘要 + 抽取出的项目知识（约定、决策、问题、方法），项目作用域。
- **手工记忆**：用户或助手显式 `remember`，来源 `manual`。
- **幂等**：`stableMemoryId` 基于 `scope + ownerId + projectId + dedupeKey`；checkpoint 只在上次写入成功且无 issue 时推进。

## 9. 召回与注入

### 召回

- 纯文本 BM25（标题 3 倍权重、tags 参与、中文按单字 + 二元组、英文/数字按词）；
- 命中后再按 kind、tag、最低置信度、有效期、敏感级过滤；
- 空查询返回作用域内最近记录（按 `updatedAt`）；
- 默认 limit 10，上限 50。

### 注入

`AgentRagClient.inject()` 组合三类结果，交给 `buildMemoryContext()`：

1. **常驻画像**：user scope 的 profile / preference / commitment（最近 3 条）；
2. **用户命中**：用 goal + 改动文件拼成的查询召回 user scope（最多 6 条）；
3. **项目命中**：同一查询召回 project scope（最多 8 条）。

渲染规则：

- 按 `scope` 分节；跨节按 `checksum/id` 去重；
- 单条约 500 字符截断，总预算 `maxChars`（默认 2500）；
- 输出一段可直接拼进 system prompt 的文本：

```text
<agent-rag-memory>
以下为长期记忆，可能过时；与当前代码或用户最新指令冲突时以最新信息为准。

## 用户记忆
- [偏好] 回复风格：先结论，后细节。
- [承诺] 本周只做稳定性修复。

## 项目记忆
- [约定] 发布分支：固定使用 release 分支。
- [任务] 修复登录超时：调整网关超时配置，测试通过。
</agent-rag-memory>
```

- 无命中时返回空字符串，助手可跳过注入。

## 10. 多端接入

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| 嵌入式 SDK | 与 Node 同进程的助手（WFXM 当前用法） | `new AgentRagClient({ store })`，注入 `butler` / `task` 端口 |
| HTTP JSON API | 独立部署、跨语言、多助手共享 | `agent-rag serve`，默认绑定 127.0.0.1，可加 Bearer token |
| MCP stdio | dsh-wfxm、支持 MCP 的 IDE/Agent | `agent-rag mcp`，暴露 context/recall/remember/report 等工具；加 `--remote <url>` 时改为 HTTP 转发，与 `serve` 共用一份数据 |

所有写入都会携带 `source.client`（`wfxm` / `dsh-wfxm` / `cli` 等），便于追溯数据来源。

## 11. 存储与演进

- **本地单用户**：`JsonTextStore`（原子写、启动重建索引），`projects.json` 保存项目身份。
- **共享/多用户**：`PostgresTextStore`（tokenized `tsvector` + `simple` 配置，中文二元组可用），直接复用现有连接池。
- **后续**：SQLite FTS5 适配、embedding 向量召回与 rerank（在不改变 `TextMemoryStore` 契约的前提下加混合检索层）、按来源撤销。

`TextMemoryStore` 契约（upsert/get/delete/deleteScope/search/listAll/stats）是存储可替换的边界。
`listAll` 只供备份/导出使用，绕过作用域过滤；召回仍必须走 `search(scope)`。

## 12. 安全与隐私

- 默认只监听 `127.0.0.1`；跨机部署必须配置 `--token`。
- 不采集遥测，不向第三方发送数据。
- `secret` 默认不召回；删除支持整作用域 `forget`。
- 仓库本身不包含任何用户数据；运行数据默认在 `~/.agent-rag/`，请勿提交。
- 开源仓库的 issue/PR 中不要粘贴真实记忆内容。

## 13. 版本与兼容

- `MEMORY_SCHEMA_VERSION = 1`。新增可选字段属于兼容变更；删除/改语义需升版本并提供迁移脚本。
- 当前 0.1.0 的能力边界：文本检索、单用户、任务/会话两类投影、MCP/HTTP/嵌入式三种接入。
- 已知限制：画像记录按会话覆盖（应由助手产出累积画像）；中文检索为字/二元组近似，未做分词；未实现多用户鉴权与审计日志。

# AGENTS.md

本文件面向在本仓库工作的 AI 开发助手。

## 项目概览

agent-rag 是个人开发助手的长期记忆库：用户/项目两级作用域，提供召回、注入与任务/会话上报；通过 MCP、HTTP、嵌入式 SDK 对接不同助手。当前版本 0.1.0，Node ≥ 22.18 原生运行 TypeScript。

## 常用命令

```bash
pnpm install
pnpm typecheck            # tsc --noEmit
pnpm test                 # node --test，全部包
node packages/server/src/cli.ts stats --store memory
```

提交前必须通过 `pnpm typecheck` 与 `pnpm test`。

## 记忆工具约定

如果当前助手已接入 agent-rag 记忆工具（名称可能是 `memory_context`、`memory_recall`、`memory_remember`、`memory_report_task`、`memory_report_session`，MCP 下带 `mcp__agent_rag__` 前缀）：

1. 会话开始：调用 `memory_context`，把返回文本作为长期记忆参考；与当前代码或用户最新指令冲突时，以最新信息为准。
2. 形成明确约定/决策时：调用 `memory_remember`，一条一个结论，不要粘贴原文或大段日志。
3. 任务结束：调用 `memory_report_task` 上报 goal、summary、status、changedFiles 与抽取出的项目知识。
4. `sensitivity=secret` 的内容不入库、不注入。

## 代码约定

- 核心层（`packages/core`）保持无 I/O 依赖；持久化放在 `packages/store-text`。
- 存储通过 `TextMemoryStore` 契约扩展；新增后端需复用现有测试语义。
- 新增公开 API 需同步 `docs/api.md` 或 `docs/architecture.md`。
- 改动后补充对应测试；测试使用 `node:test`，文件名 `*.test.ts`。

## 数据安全

- 运行数据默认在 `~/.agent-rag/`，禁止提交 `memory.json`、`projects.json` 或任何真实记忆内容。
- 不要在测试、文档、提交信息中写入真实用户信息或口令。

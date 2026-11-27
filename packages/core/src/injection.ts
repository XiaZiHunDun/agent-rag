import type { MemoryKind, MemoryScope, MemorySource } from "./memory-record.ts"
import type { MemoryHit } from "./retrieval.ts"

/**
 * Context injection rendering.
 *
 * The caller is responsible for ordering and selecting hits (query recall plus
 * always-on profile records); this module dedupes, budgets and renders a block
 * that can be prepended to a system prompt as-is.
 */

export const DEFAULT_CONTEXT_MAX_CHARS = 2500
export const MAX_CONTEXT_ITEM_CHARS = 500
const MIN_CONTEXT_MAX_CHARS = 200
const OPEN_TAG = "<agent-rag-memory>"
const CLOSE_TAG = "</agent-rag-memory>"
const DISCLAIMER = "以下为长期记忆，可能过时；与当前代码或用户最新指令冲突时以最新信息为准。"

const KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  profile: "画像",
  preference: "偏好",
  relationship: "关系",
  commitment: "承诺",
  decision: "决策",
  convention: "约定",
  recipe: "方法",
  issue: "问题",
  task_summary: "任务",
  note: "记录",
}

export interface MemoryContextInput {
  /** User-scope hits, already ordered by the caller. */
  readonly user?: readonly MemoryHit[]
  /** Project-scope hits, already ordered by the caller. */
  readonly project?: readonly MemoryHit[]
  readonly maxChars?: number
}

export interface MemoryContextEntry {
  readonly id: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly title: string
  readonly text: string
  readonly score: number
  readonly confidence: number
  readonly source: MemorySource
  readonly updatedAt: string
}

export interface MemoryContextResult {
  /** Empty string when there is nothing to inject. */
  readonly text: string
  readonly entries: readonly MemoryContextEntry[]
  readonly usedChars: number
  readonly truncated: boolean
}

function dedupeKey(hit: MemoryHit): string {
  return hit.record.checksum ?? hit.record.id
}

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONTEXT_MAX_CHARS
  return Math.max(MIN_CONTEXT_MAX_CHARS, Math.floor(value))
}

function normalizeText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= MAX_CONTEXT_ITEM_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_CONTEXT_ITEM_CHARS - 1)}…`
}

function toEntry(hit: MemoryHit): MemoryContextEntry {
  const record = hit.record
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    title: record.title,
    text: normalizeText(record.text),
    score: hit.score,
    confidence: record.confidence,
    source: record.source,
    updatedAt: record.updatedAt,
  }
}

/** Build the injectable memory block. Returns "" when no entries fit. */
export function buildMemoryContext(input: MemoryContextInput): MemoryContextResult {
  const maxChars = clampMaxChars(input.maxChars)
  const seen = new Set<string>()
  const entries: MemoryContextEntry[] = []
  const userEntries: MemoryContextEntry[] = []
  const projectEntries: MemoryContextEntry[] = []
  let truncated = false

  const collect = (hits: readonly MemoryHit[] | undefined, target: MemoryContextEntry[]): void => {
    for (const hit of hits ?? []) {
      const key = dedupeKey(hit)
      if (seen.has(key)) continue
      seen.add(key)
      target.push(toEntry(hit))
    }
  }

  collect(input.user, userEntries)
  collect(input.project, projectEntries)
  if (userEntries.length === 0 && projectEntries.length === 0) {
    return { text: "", entries: [], usedChars: 0, truncated: false }
  }

  const lines: string[] = [OPEN_TAG, DISCLAIMER]
  let used = lines.join("\n").length

  const renderSection = (title: string, sectionEntries: readonly MemoryContextEntry[]): void => {
    if (sectionEntries.length === 0) return
    const sectionLines: string[] = ["", `## ${title}`]
    for (const entry of sectionEntries) {
      const line = `- [${KIND_LABELS[entry.kind]}] ${entry.title}：${entry.text}`
      if (used + line.length + 1 > maxChars) {
        truncated = true
        break
      }
      sectionLines.push(line)
      used += line.length + 1
      entries.push(entry)
    }
    if (sectionLines.length > 2) lines.push(...sectionLines)
  }

  renderSection("用户记忆", userEntries)
  renderSection("项目记忆", projectEntries)

  if (entries.length === 0) {
    return { text: "", entries: [], usedChars: 0, truncated: truncated || seen.size > 0 }
  }

  lines.push(CLOSE_TAG)
  const text = lines.join("\n")
  return { text, entries, usedChars: text.length, truncated }
}

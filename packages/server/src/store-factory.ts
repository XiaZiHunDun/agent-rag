import { homedir } from "node:os"
import { join } from "node:path"
import type { ProjectRegistry, TextMemoryStore } from "@agent-rag/core"
import { InMemoryProjectRegistry } from "@agent-rag/core"
import {
  InMemoryTextStore,
  JsonProjectRegistry,
  JsonTextStore,
} from "@agent-rag/store-text"

export type StoreKind = "json" | "memory"

export interface OpenStoresOptions {
  readonly store?: StoreKind
  readonly dataDir?: string
}

export interface OpenedStores {
  readonly store: TextMemoryStore
  readonly registry: ProjectRegistry
  readonly dataDir: string
  readonly memoryFile?: string
  readonly projectsFile?: string
}

export function defaultDataDir(): string {
  return process.env["AGENT_RAG_HOME"] ?? join(homedir(), ".agent-rag")
}

/** Open the memory store and project registry used by the server/CLI. */
export async function openStores(options: OpenStoresOptions = {}): Promise<OpenedStores> {
  const dataDir = options.dataDir ?? defaultDataDir()
  const kind = options.store ?? "json"

  if (kind === "memory") {
    return { store: new InMemoryTextStore(), registry: new InMemoryProjectRegistry(), dataDir }
  }

  const memoryFile = join(dataDir, "memory.json")
  const projectsFile = join(dataDir, "projects.json")
  const [store, registry] = await Promise.all([
    JsonTextStore.open(memoryFile),
    JsonProjectRegistry.open(projectsFile),
  ])
  return { store, registry, dataDir, memoryFile, projectsFile }
}

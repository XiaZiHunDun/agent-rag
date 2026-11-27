import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  InMemoryProjectRegistry,
  type ProjectIdentity,
  type ProjectRegistryOptions,
} from "@agent-rag/core"

interface RegistryFile {
  readonly version: 1
  readonly identities: readonly ProjectIdentity[]
}

/**
 * JSON-file backed project registry.
 *
 * Kept separate from the memory snapshot so project identities survive store
 * migrations and can be inspected or edited by hand.
 */
export class JsonProjectRegistry extends InMemoryProjectRegistry {
  private readonly filePath: string

  private constructor(filePath: string, options: ProjectRegistryOptions) {
    super(options)
    this.filePath = filePath
  }

  static async open(
    filePath: string,
    options: ProjectRegistryOptions = {},
  ): Promise<JsonProjectRegistry> {
    const registry = new JsonProjectRegistry(filePath, options)
    try {
      const raw = await readFile(filePath, "utf8")
      const parsed = JSON.parse(raw) as Partial<RegistryFile>
      const issues = InMemoryProjectRegistry.validateSnapshot(parsed)
      if (issues.length > 0) {
        throw new Error(`invalid project registry: ${issues.join("; ")}`)
      }
      registry.load(parsed.identities as readonly ProjectIdentity[])
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
    return registry
  }

  protected override async persist(): Promise<void> {
    const snapshot: RegistryFile = { version: 1, identities: this.snapshot() }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    await rename(tempPath, this.filePath)
  }
}

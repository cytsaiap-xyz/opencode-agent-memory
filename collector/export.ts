import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { MemoryConfig } from "../shared/config"
import { projectSlug } from "../shared/config"
import { loadSessionBundle } from "./db"
import { renderTranscript } from "./transcript"

export type ExportOutcome = { status: "written" | "unchanged" | "skipped"; reason?: string; path?: string }

export async function exportSession(
  cfg: MemoryConfig,
  dbPath: string,
  sessionID: string,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const bundle = loadSessionBundle(dbPath, sessionID)
  if (!bundle) return { status: "skipped", reason: "not found" }
  if (bundle.session.parent_id) return { status: "skipped", reason: "child session" }

  const slug = projectSlug(bundle.session.directory)
  const ignored = cfg.ignoredProjects.some((p) => p === slug || bundle.session.directory.includes(p))
  if (ignored) return { status: "skipped", reason: "ignored project" }

  const rendered = renderTranscript(bundle, now)
  if (rendered.userTurns < cfg.minUserTurns) return { status: "skipped", reason: "too few user turns" }

  const path = join(cfg.transcriptsDir, slug, `${bundle.session.id}.md`)
  const existing = Bun.file(path)
  if (await existing.exists()) {
    const head = (await existing.text()).slice(0, 600)
    if (head.includes(`content_hash: ${rendered.contentHash}`)) return { status: "unchanged", path }
  }

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, rendered.markdown)
  return { status: "written", path }
}

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { anchorsIn, isEligible, parseTranscript, scanSpool } from "./transcripts"

const tmp = () => mkdtempSync(join(tmpdir(), "amem-ts-"))

const sample = (sessionId: string, timeEnd: string) => `---
session_id: ${sessionId}
project_dir: "/x/projA"
title: "Fix \\"quoted\\" thing"
model: "opencode/big-pickle"
time_start: 2026-07-10T02:00:00.000Z
time_end: ${timeEnd}
turns: 2
tokens: { input: 10, output: 5 }
content_hash: sha256:abcdef0123456789
exported_at: 2026-07-10T03:00:00.000Z
---
## T1 [02:00] User {#msg_u1}

please fix the thing

## T2 [02:01] Assistant {#msg_a1}

fixed it
`

test("parseTranscript extracts meta and body; unquotes title", () => {
  const md = sample("ses_p", "2026-07-10T02:30:00.000Z")
  const m = parseTranscript("/spool/proja/ses_p.md", md)
  expect(m.sessionId).toBe("ses_p")
  expect(m.project).toBe("proja")
  expect(m.contentHash).toBe("sha256:abcdef0123456789")
  expect(m.timeEnd).toBe("2026-07-10T02:30:00.000Z")
  expect(m.title).toBe('Fix "quoted" thing')
  expect(m.body).toContain("## T1")
  expect(m.body).not.toContain("content_hash")
})

test("parseTranscript throws on missing session_id", () => {
  const md = sample("ses_p", "2026-07-10T02:30:00.000Z").replace(/^session_id: .*$/m, "")
  expect(() => parseTranscript("/spool/p/x.md", md)).toThrow(/session_id/)
})

test("scanSpool walks project dirs and sorts by timeEnd", () => {
  const dir = tmp()
  mkdirSync(join(dir, "proja"), { recursive: true })
  mkdirSync(join(dir, "projb"), { recursive: true })
  writeFileSync(join(dir, "proja", "ses_2.md"), sample("ses_2", "2026-07-10T05:00:00.000Z"))
  writeFileSync(join(dir, "projb", "ses_1.md"), sample("ses_1", "2026-07-10T01:00:00.000Z"))
  writeFileSync(join(dir, "proja", "junk.txt"), "not a transcript")
  const metas = scanSpool(dir)
  expect(metas.map((m) => m.sessionId)).toEqual(["ses_1", "ses_2"])
  expect(metas[0]!.project).toBe("projb")
})

test("scanSpool skips unparseable transcripts instead of throwing", () => {
  const dir = tmp()
  mkdirSync(join(dir, "proja"), { recursive: true })
  writeFileSync(join(dir, "proja", "bad.md"), "no frontmatter here")
  writeFileSync(join(dir, "proja", "ok.md"), sample("ses_ok", "2026-07-10T01:00:00.000Z"))
  expect(scanSpool(dir).map((m) => m.sessionId)).toEqual(["ses_ok"])
})

test("isEligible respects idle window", () => {
  const m = parseTranscript("/s/p/x.md", sample("s", "2026-07-10T00:00:00.000Z"))
  expect(isEligible(m, new Date("2026-07-10T07:00:00.000Z"), 6)).toBe(true)
  expect(isEligible(m, new Date("2026-07-10T03:00:00.000Z"), 6)).toBe(false)
})

test("anchorsIn finds every heading anchor", () => {
  const m = parseTranscript("/s/p/x.md", sample("s", "2026-07-10T00:00:00.000Z"))
  expect(anchorsIn(m.body)).toEqual(new Set(["msg_u1", "msg_a1"]))
})

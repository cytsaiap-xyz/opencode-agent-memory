# LLM_WIKI — opencode-agent-memory

給下一個接手這個 repo 的 agent 讀的架構速查表。詳細規格見文件對照表。

## 架構總覽（三元件與資料流）

單一 monorepo，三個元件，全部 on-prem，不打任何外部 API：

```
opencode.db (live, WAL)
   │  read-only open (bun:sqlite { readonly: true })
   ▼
[collector]  session.idle(sessionID) ──► 匯出 transcript
   │
   ▼
~/.agent-memory/transcripts/<project-slug>/<session_id>.md   (spool，每次全量覆寫 + content_hash)
   │
   ▼  cron / 手動執行
[distiller]  INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH   ← 已實作（見下方「Distiller」章節）
   │
   ▼
~/.agent-memory/store/memories/**.md, index.db (FTS5)
   │
   ▼
[mcp-server]  search_memory / get_memory / list_domains / memory_stats   ← 已實作（見下方「MCP Server」章節）
```

本 repo 三個元件 **`collector/`**、**`distiller/`**、**`mcp-server/`** 都已
出貨。`AGENT_MEMORY_HOME`（預設 `~/.agent-memory`）是所有輸出的根目錄，設計
上 `store/` 之後會整包進 git，跟現有的 markdown LLM-wiki 系統共用生態。

collector 的職責僅止於「把一個 session 從資料庫轉成人類可讀的 markdown」，
不做過濾知識、不呼叫 LLM——那是 distiller 的事。collector 本身是 stateless，
同一個 session 多次 idle 就多次覆寫，靠 `content_hash` 判斷內容是否變動
（見下方「中繼格式契約摘要」）。

## 入口點

- **`collector/plugin-entry.ts`** — bundle 的唯一進入點。`bun run build` 會把
  它打包成 `dist/agent-memory-collector.js`，交給
  `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/` 使用。這支檔案**只能
  export function**（見下方陷阱），目前只 export `AgentMemoryCollector`
  （named + default 都指向同一個 plugin function）。實際邏輯在
  `collector/plugin.ts` 的 `createCollectorPlugin()`：註冊 `event` hook，
  過濾 `session.idle`，呼叫 `collector/export.ts` 的 `exportSession()`，
  結果寫進 `collector.log`，任何錯誤都被 try/catch 吞掉、絕不 throw
  （不能弄壞 host session）。
- **`collector/backfill.ts`** — CLI 進入點（`if (import.meta.main)`），跟
  plugin 走同一條 `exportSession()` 邏輯，差別是主動列出
  `listRootSessionIDs()`（`collector/db.ts`，只抓 `parent_id IS NULL` 的
  session）逐一匯出，不靠 event hook 觸發。支援 `--db <path>`、
  `--limit <N>`。用途：裝上 plugin 之前，資料庫裡已經累積的歷史 session
  一次性補匯出（開發機上已有數百筆）。

## 常用指令

```bash
bun install
bun test              # bun:test，collector/ + shared/ 全部單元測試
bun run typecheck      # tsc --noEmit
bun run build          # collector/plugin-entry.ts -> dist/agent-memory-collector.js
./scripts/install.sh   # build + 安裝進 opencode plugins 目錄 + broken-main 檢查
bun collector/backfill.ts [--db <path>] [--limit <N>]
bun run distill run [--project <slug>]   # 跑一次蒸餾 pipeline
bun run distill reindex                  # 從 memories/ 重建 index.db
bun run distill review                   # 列出待人工審查的 quarantine 項目
bun run distill stats                    # 印出 status/type 統計 + 已處理 session 數
bun run mcp                              # 啟動 mcp-server（stdio）
bun run mcp:probe "<query>" | --stats    # 不經任何 MCP host，直接探測 server
```

## 中繼格式契約摘要（spec §5）

每個 session 匯出成一份 markdown，YAML frontmatter + 逐輪 turn：

```markdown
---
session_id: ses_…
project_dir: "/path/to/project"
title: "…"
model: "provider/model"
time_start: ISO8601
time_end: ISO8601
turns: 22
tokens: { input: 43821, output: 6469 }
content_hash: sha256:9e1159a3827a3c90     # 對 rendered body 算 hash，用於 idempotency
exported_at: ISO8601
---
## T1 [15:08] User {#msg_c5cb1fd710012z2Z1AYeaLc7B9}

<user text>

## T2 [15:09] Assistant {#msg_…}

<assistant text>

> 🔧 <tool> <input ≤160 chars> → <status>
```

重點：
- `{#msg_id}` 錨點是**證據契約**——之後 distiller 抽出的每一條 memory 都必須
  引用真實存在的錨點，可被程式化驗證（防幻覺）。
- 捨棄 `reasoning`、`step-start`、`step-finish`、`snapshot`、`patch` 這幾種
  part type；`tool` part 一律壓成單行摘要（工具名 + input ≤160 字 + 狀態）。
- 完整保真資料永遠留在 `opencode.db`；transcript 只是給 distiller 看的精簡
  視圖，不是備份。
- `content_hash` 判斷邏輯在 `collector/export.ts`：讀舊檔前兩個 `---` 之間
  的 frontmatter，若已含相同 `content_hash: ...` 字串則視為 `unchanged`，
  否則整份覆寫並標記 `written`。**這是字串比對，不是重新 parse YAML**——
  改動 frontmatter 欄位順序或格式要小心不要動到 `content_hash` 那一行的
  精確文字。

## 已知陷阱

1. **opencode plugin loader 只接受 function exports。** loader 會對
   bundle 的 `Object.values(module)` 逐一檢查，只要有一個 export 不是
   function，整個 module 就被判定載入失敗、整包不啟用。因此
   `collector/plugin-entry.ts` 刻意只 export `AgentMemoryCollector`
   這一個 plugin function（named + default），不要在這支檔案裡加其他
   export（型別除外，型別在編譯後不會出現在 bundle 裡）。
2. **`~/.config/opencode/plugins/` 目錄裡壞掉的 `package.json.main` 會滅
   團。** 如果該目錄下有 `package.json`，且它的 `"main"` 欄位指到一個不
   存在的檔案，opencode 會**整個 plugins 目錄都不載入**，不只是壞掉的
   那一個 plugin——包括這個 collector 也會一起失效，而且是**靜默失敗**
   （沒有明顯錯誤訊息）。`scripts/install.sh` 每次安裝都會主動檢查這個
   陷阱並印出紅字警告。修法：備份後移除該 `package.json` 的 `main`
   欄位，重啟 opencode。
3. **`opencode.db` 是正在跑的 opencode 實例持續寫入的 live WAL 資料
   庫。** collector 一律用 `new Database(dbPath, { readonly: true })`
   （`collector/db.ts`）唯讀開啟，跟正在運行中的 opencode 併發存取是
   安全的（Spike A 已驗證）。**絕對不要**改成非 readonly 開啟，也不要
   對這個 DB 做任何寫入。
4. **`content_hash` 的覆寫語義：全量覆寫，不是 append。** 同一個
   session 每次 idle 都會重新渲染整份 transcript 並整份覆寫舊檔（見
   `collector/export.ts`）。沒有變化時（`content_hash` 相同）才會跳過
   寫入、回傳 `unchanged`。之後 distiller 的 idempotency 是靠這個
   `content_hash` 搭配 ledger 做的，不是靠檔案內容 diff。
5. **`opencode run` 的 `-f`/`--file` 是 yargs 陣列 flag，會貪婪吃掉後面
   的 message 位置參數**（Spike A 記錄的 gotcha：`opencode run --file=x
   "<msg>"` 會出現 `File not found: <msg 內容>` 的錯誤）。正確順序是
   **訊息在前、flag 在後**：`opencode run "<msg>" --file=x.md`。這個坑
   跟 collector 本身無關（collector 不呼叫 `opencode run`），distiller 的
   `OpencodeRunClient`（`distiller/llm.ts`）已經照這個順序實作——細節與
   一個尚未緩解的變形風險見下方「Distiller」章節已知陷阱補充第 3 條。

## Distiller

`distiller/` 把 spool 裡閒置夠久的 transcript 蒸餾成結構化、去重過的
memory entry，寫進 `store/`。跟 collector 不同，它不是 per-session 觸發，
是排程跑的 batch job（cron/launchd，見 README「Scheduling」）。

### 管線階段與職責（`distiller/pipeline.ts`）

```
INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH
```

1. **INGEST**（`transcripts.ts: scanSpool` + `isEligible`）— 掃描
   `transcripts/` spool，用 `(session_id, content_hash, pipeline_version)`
   當 ledger 主鍵判斷是否已處理過（`ledger.ts: isProcessed`）；只有距離
   `time_end` 已超過 `AGENT_MEMORY_IDLE_HOURS`（預設 6 小時）的 transcript
   才算 eligible。
2. **TRIAGE**（`pipeline.ts` 常數 `TRIAGE_MIN_BODY = 400`）— 不呼叫 LLM
   的便宜過濾：transcript body 少於 400 字元直接跳過，但仍會寫一筆
   `n_candidates: 0` 的 ledger row，避免下次重掃。
3. **EXTRACT**（`extract.ts: buildExtractPrompt` + `EXTRACT_SCHEMA`）— 對
   大模型丟整份 transcript body，要求嚴格 JSON array，六型分類見下方；
   `salience` 低於 `AGENT_MEMORY_SALIENCE_MIN`（預設 6）的項目直接靜默
   丟棄（不算進 rejected 統計）。
4. **VALIDATE**（`extract.ts: validateCandidates`，純程式邏輯、不呼叫
   LLM）— 逐欄位檢查必填/型別、`evidence[].message_id` 必須對應到
   transcript 裡真實存在的 `{#msg_id}` 錨點（`transcripts.ts:
   anchorsIn`；幻覺錨點直接 reject 該候選）、`lesson` ≤ 80 字，以及
   secret/高熵字串掃描（`scanSecrets`）——命中 secret 的候選不是被
   reject，是被送進 quarantine（見下）。
5. **RECONCILE**（`reconcile.ts`，Mem0 風格）— 用候選的 title+lesson 對
   `index.db` 做 FTS 查詢，抓 top 5 個 `status: active` 的既有 memory 當
   neighbor，再丟給 LLM 選擇恰好一種操作：`ADD` / `UPDATE` / `SUPERSEDE`
   / `NOOP`。`SUPERSEDE` 只會把舊 entry 標成 `status: superseded` +
   `superseded_by: <new_id>`，**從不刪除檔案**。
6. **COMMIT**（`store.ts: writeEntry` + `ledger.ts: recordProcessed`）—
   寫入/更新 memory markdown 檔，並記一筆 ledger row（`n_candidates`/
   `n_committed`）。
7. **PUBLISH**（`pipeline.ts: renderIndexMd`）— 重新產生
   `store/INDEX.md`（依 project 分組、依 type 再依 confidence 降冪排
   序，附上 Quarantine 清單）。**注意：`renderIndexMd` 只在 `distill
   run` 結尾跑一次，`reindex`/`review`/`stats` 都不會重新產生
   INDEX.md。**

### 六型分類（`extract.ts`、`types.ts: MemoryType`）

`decision`（技術決策+理由，尤其是使用者推翻 agent 建議的情況）、
`root_cause`（症狀→根因→已驗證的修法）、`pitfall`（看起來對但會出錯，
以及為什麼）、`know_how`（工具/領域知識）、`convention`（團隊慣例）、
`workflow`（可重用的多步驟流程）。`memory_class` 由程式決定、不是 LLM
選的：`type === "workflow"` → `procedural`，其餘五型一律 →
`semantic`（`episodic` 目前完全沒用到，型別裡保留給未來的原始事件記
錄）。

### Confidence 公式（spec §6 修正緣由）

```
confidence = clamp(0.5 + 0.15·(sessions-1) + 0.2·human_approved - 0.25·contradicted, 0.1, 0.95)
```

（`store.ts: computeConfidence`，四捨五入到小數點後 2 位）。基準是
**0.5** 而不是原本直覺的 0.4：因為能走到這一步的候選都已經先過了
salience 門檻，如果基準是 0.4，每一筆剛抽出來的單 session memory 都會
落在 mcp-server 預設查詢門檻 `confidence >= 0.5` 之下——等於蒸餾出來的
東西第一天就對搜尋隱形。這個修正記在 spec
`docs/superpowers/specs/2026-07-10-agent-memory-design.md` §6（2026-07-10
Plan 2 設計期間修正）。

### 冪等 ledger 鍵

`processed_sessions` 表的 primary key 是 `(session_id, content_hash,
pipeline_version)`（`ledger.ts` DDL；`PIPELINE_VERSION = "1"`，
`types.ts`）。同一個 session 只要 `content_hash` 沒變就不會重新蒸餾；
`content_hash` 變了（transcript 內容被 collector 整份覆寫）或
`pipeline_version` 升版，才會重新處理同一個 session_id。TRIAGE 階段也
會寫 ledger row（代表「處理過但沒有候選」），所以極短的 transcript 也
不會每次重掃。

### Quarantine 審查流程

Secret/高熵字串命中的候選不會被丟棄，而是寫成獨立檔案到
`store/quarantine/<id>.md`（`store.ts: quarantinePath`），同時也會被
`index.upsertEntry` 記進 `memories` 表（`status: quarantined`）。

跑 `bun run distill review` 會做兩件事：
1. 掃 `memories/` 底下所有 entry，找出 `status === "quarantined"` 的
   （人工手動把項目搬進 `memories/` 但還沒改 status 的情況）。
2. 直接掃 `quarantine/` 目錄下的所有 `.md` 檔（pipeline 正常產生
   quarantine 的路徑）。

兩邊都列出來、依 id 去重，印出 `<id> — <title> (<最後一則 note>)`；
壞掉（parse 失敗）的檔案不會讓整個列表噴掉，只會印到 stderr 說
`skipping corrupt entry: <path>`。**目前沒有自動化的「核准」指令**——
人工審查後要嘛編輯 quarantine 裡的檔案（改 `review: human_approved`、
`status: active`）並手動搬進 `memories/<project>/`，要嘛直接刪掉；
改完之後跑 `bun run distill reindex` 讓 `index.db` 跟磁碟同步。

### 與 collector 的介面（transcript frontmatter 契約）

`transcripts.ts: parseTranscript` 只讀 transcript frontmatter 的
`session_id`、`content_hash`、`time_end`、`exported_at`、`title` 這五個
必填欄位；**`project` 不是從 frontmatter 的 `project_dir` 讀出來的，是
從檔案所在目錄的 basename 推出來的**（`basename(dirname(path))`）——也
就是 collector 匯出時用來建目錄的 project slug，distiller 端只信任目錄
結構，不信任 frontmatter 裡的 `project_dir` 欄位。`{#msg_id}` 錨點是雙
方共用的證據契約：collector 產生錨點，distiller 的 VALIDATE 階段驗證
每個 `evidence[].message_id` 都對應到 transcript 裡真的存在的錨點。

### 已知陷阱補充

1. **FTS5 查詢字串必須先 sanitize，不能把使用者輸入直接丟進
   MATCH。** `ledger.ts: ftsQuery` 把查詢字串依 `[^\p{L}\p{N}_]+` 切
   token、每個 token 各自加雙引號再用 `OR` 接起來，這樣使用者輸入的
   FTS5 特殊字元（`AND`/`OR`/`NOT`、欄位過濾 `col:x`、`*`、括號…）不
   會被當成語法解析而噴 `fts5: syntax error`，也不會不小心跨欄位查
   詢。之後 mcp-server 的 `search_memory` **一定要**重用
   `MemoryIndex.search()`，不要自己組 FTS5 查詢字串。
2. **SQLite FTS5 預設 tokenizer（unicode61）不會斷詞 CJK。** 目前
   `memories_fts` 沒有另外指定 tokenizer，中文/日文這類沒有空白分隔
   的文字整段會被當一個 token，做不到「查兩個字就命中包含它的長字
   串」這種效果。目前 extract prompt 是英文、`lesson` 也預期以英文
   輸出，影響有限；但如果之後允許中文 lesson 或 `## Notes` 大量塞
   中文，FTS 命中率會明顯變差（Plan 2 Task 2 遺留項目，尚未有
   workaround，見 `.superpowers/sdd/progress.md`）。
3. **`opencode run` 訊息一定要放在 flags 前面，開頭是 `-` 的訊息仍有
   殘留風險。** `llm.ts: createOpencodeRunClient` 已經照 Spike A 的教
   訓把 message 放在 `["opencode", "run", message, "--pure", "--title",
   "distiller"]` 的第一個位置參數、`--pure`/`--title` 放後面，避免
   yargs 陣列 flag（`-f`/`--file`）貪婪吃掉 message。但如果 LLM
   prompt 或 system 文字剛好以 `-` 開頭（例如以項目符號開頭的長
   prompt），yargs 仍可能把整段訊息誤判成一個未知 flag，而不是當成
   positional 參數——這個風險目前**沒有**被 `--` 分隔符或前綴
   sentinel 緩解（Plan 2 Task 4 遺留項目）。
4. **vLLM backend 需要伺服器支援 guided decoding，不是隨便一個
   OpenAI 相容端點都夠。** `llm.ts: createVllmClient` 只要 request 帶
   了 `schema` 就一定送 `response_format: { type: "json_schema", ...
   }`；如果指向的 vLLM 沒有開 `--guided-decoding-backend`（或引擎不
   支援 guided JSON），請求可能直接失敗，或伺服器忽略
   `response_format`、回傳非結構化文字，導致下游 `JSON.parse` 炸掉。
5. **（已修，Plan 2 final wave）`reindex` 現在同時掃 `store/quarantine/`
   ——但如果你只信任 `store.ts: listEntryPaths` 沒改就以為 quarantine
   還是漏的，會白繞一圈。** `ledger.ts: rebuildFrom` 原本只清空
   `memories`/`memories_fts` 兩張表再用 `listEntryPaths` 重新掃一次，
   而 `listEntryPaths` **只走 `store/memories/` 這棵樹**，不掃
   `store/quarantine/`，導致 `reindex` 之後 quarantine 項目從
   `index.db` 的 `memories` 表消失（`getById`/`search` 查不到，
   `bun run distill review` 因為直接讀目錄不受影響）。現在
   `rebuildFrom` 額外 `readdirSync(quarantine/)` 把這批也塞回去，同時
   遇到單一檔案 parse 失敗只 warn+跳過、不會中途整批 abort（見下一
   條）。
6. **`reindex` 重建的只有 memories + quarantine 這兩份資料的 FTS
   索引，`processed_sessions`（冪等 ledger）和 access 統計都不在重建
   範圍內；砍掉整個 `index.db` 檔案會連 ledger 一起清空。**
   `ledger.ts: rebuildFrom` 只 `DELETE FROM memories` /
   `memories_fts` 再從磁碟檔案重新灌回去——`processed_sessions`（`bun
   run distill run` 的 `isProcessed`/`recordProcessed` 用來判斷「這個
   session 是否已經處理過」）和 `memories.access_count` /
   `last_accessed` 完全不會被重建，因為它們不是從 `store/memories/`
   或 `store/quarantine/` 的 markdown 檔案衍生出來的，本來就沒有磁碟
   上的真相來源可以回填。所以「`rm index.db` 再 `reindex`」只能恢復
   memory 條目本身；下一次 `distill run` 會把每個 transcript session
   當成沒處理過，重新跑一次完整的 LLM 抽取（`VERIFY-distiller.md`
   item 4 曾經誤寫成兩者等價，已更正）。

## MCP Server

`mcp-server/` 是整個系統唯一的讀取介面：agent 透過 MCP（`stdio` transport）
呼叫四個 tool 查詢 `store/`，本身不參與 collector/distiller 的寫入路徑。

### 架構（三層）

1. **query 層**（`mcp-server/query.ts`）— 純函式，吃 `MemoryIndex`
   （`distiller/ledger.ts`，跟 distiller 共用同一支 SQLite wrapper）+
   `storeDir`，輸出給 tool 用的 plain object。`searchMemory` / `getMemory` /
   `listDomains` / `memoryStats` 四個函式對應四個 tool，邏輯與 MCP SDK 完全
   解耦，可以直接單元測試（`query.test.ts`）不用起 server。
2. **server 層**（`mcp-server/server.ts`）— `buildServer(deps)` 用
   `@modelcontextprotocol/sdk` 的 `McpServer` 註冊四個 tool，每個 handler
   都包一層 `guarded()`（try/catch → `{ isError: true, content: [...] }`，
   絕不讓 tool call 讓整個 server process 掛掉）。inputSchema 用 zod 定義，
   同時也是 MCP host 端看到的參數說明來源。
3. **stdio 入口**（`mcp-server/main.ts`）— `import.meta.main` 守衛；
   `loadConfig()` 讀 `AGENT_MEMORY_HOME`、`mkdirSync(storeDir)`、開
   `MemoryIndex(index.db)`、`buildServer()`、接上
   `StdioServerTransport`、註冊 `SIGINT`/`SIGTERM` 關閉 `index`。
   `mcp-server/probe.ts` 是平行的第二個入口：同樣建 `buildServer()`，但接
   `InMemoryTransport` 而不是真的 stdio，讓開發者/驗證流程不需要任何
   MCP host 就能直接呼叫 tool（`bun run mcp:probe`）。

### 四個 tool 與預設過濾

| Tool | 參數 | 回傳 | 用途 |
|---|---|---|---|
| `search_memory` | `query`（必填）、`project?`、`type?`、`domain?`、`include_tentative?`、`limit?`（1-50，預設 10） | 依相關度排序的 `{id, title, trigger, lesson, type, project, domain, confidence, updated_at}` 陣列 | 解決問題前先查有沒有人踩過 |
| `get_memory` | `id` | 完整 entry（含 evidence、`## Notes`）+ `path` | 已知 id，要看完整證據/備註 |
| `list_domains` | `project?` | 依 domain / type / project 的 active memory 計數 | 查詢前先摸底有哪些 domain、哪些 project |
| `memory_stats` | *(無)* | `byStatus`、`byType`、`sessions`、`lastProcessedAt`、`quarantineFiles` | 確認 store 健康狀況、distiller 有沒有在跑 |

`search_memory` 的預設過濾是 **`status = active AND confidence >= 0.5`**
（`query.ts` 呼叫 `index.search()` 時傳 `status: "active"`、
`minConfidence: opts.include_tentative ? 0 : 0.5`）——這正是 distiller
confidence 公式基準取 0.5 而非 0.4 的原因（見上方「Confidence 公式」）：預設
情況下低於 0.5 的候選對 `search_memory` 完全不可見。傳 `include_tentative:
true` 會把 `minConfidence` 降到 0，連剛蒸餾出來、還沒累積第二次證據的候選
也會被搜到。`list_domains` 另外自己過濾 `status !== "active"` 跳過（不吃
`include_tentative`），`memory_stats` 則是全表統計，不分 status。

### 排序公式（bm25 rank-position boost 版）

`query.ts: searchMemory` 的排序**不是**把 bm25 分數、confidence、recency
三者直接相加。原因記在程式碼註解裡：SQLite 的 `bm25()` 分數在小型 store
上量級常常小到 `~1e-6`，如果直接跟 confidence（0.1-0.95）、recency bonus
相加，後兩項會直接主導排序結果，bm25 排出來的相關度順序反而形同虛設。

實際作法：

```
score(i) = i - confidence - (recent ? 0.75 : 0)
```

- `i` 是 `index.search()` 回傳結果裡的**排名位置**（0-based，已經是 bm25
  由好到壞排序後的名次），不是原始 bm25 分數本身。
- `confidence` 直接減（越高的 confidence 讓 score 越小 → 排序越前面）。
- `recent` 是「`updated_at` 落在 `now` 往前 30 天內」的布林值，命中再減
  `0.75`。
- 最後依 `score` 由小到大重排（`Array.sort`），再切 `limit`（預設 10，
  上限 50）。

效果：confidence 落在 `[0.1, 0.95]`、recency bonus 固定 `0.75`，兩者相加
最多讓一筆結果的名次移動約 `0.95 + 0.75 ≈ 1.7` 個名次寬度——也就是
confidence/recency 只能在「相鄰名次」之間做微調，**不能**讓排名第 10 的
結果跳到第 1 名去蓋過真正 bm25 相關度更高的結果。這是 fix round 1 修正的
版本；修正前的寫法是直接把 confidence/recency 加到原始 bm25 分數上，會被
上述量級問題完全稀釋掉 bm25 排序。

搜尋完成後，`search_memory` 對回傳的每一筆結果呼叫
`index.recordAccess(id)`（`UPDATE memories SET access_count = access_count
+ 1, last_accessed = ?`），`get_memory` 同樣會對命中的單筆記錄 access——
這是唯二會寫入 `index.db` 的路徑（見下方已知注意事項）。

### 註冊方式

- **opencode**（`~/.config/opencode/opencode.json` 或 per-project
  `opencode.json`）：
  ```json
  {
    "mcp": {
      "agent-memory": {
        "type": "local",
        "command": ["bun", "/ABSOLUTE/PATH/TO/opencode-agent-memory/mcp-server/main.ts"]
      }
    }
  }
  ```
  欄位形狀對照 `@opencode-ai/sdk` 的 `McpLocalConfig`：`type: "local"`、
  `command: string[]`、可選 `environment`（例如覆寫 `AGENT_MEMORY_HOME`）。
- **Claude Code**：`claude mcp add agent-memory -- bun
  /ABSOLUTE/PATH/TO/opencode-agent-memory/mcp-server/main.ts`。
- **probe（不需要任何 MCP host）**：`bun run mcp:probe "<query>"
  [--project <slug>]` 呼叫 `search_memory`；`bun run mcp:probe --stats`
  呼叫 `memory_stats`。內部用 `InMemoryTransport.createLinkedPair()` 接同
  一支 `buildServer()`，跟正式 stdio 路徑共用全部邏輯，差別只在 transport。

### 已知注意事項

1. **`stdout` 是 MCP 協定通道，任何 log 都不能寫到 `stdout`。**
   `main.ts` 唯一的一行狀態輸出用 `console.error(...)`（→ stderr），不是
   `console.log`——MCP 的 JSON-RPC framing 就走 stdio 的 stdout，任何非
   協定內容混進去都會讓 host 端解析失敗。`probe.ts` 反過來刻意用
   `console.log` 印工具回傳的文字，因為 probe 走的是 in-memory
   transport，不佔用真正的 stdio 通道，此時 stdout 就是給人看的輸出。
2. **access 統計是 mcp-server 唯一的寫入路徑。** `search_memory` /
   `get_memory` 呼叫 `index.recordAccess()` 更新
   `memories.access_count` / `last_accessed`；除此之外 mcp-server 對
   `store/` 底下任何檔案、任何其他資料表都是唯讀。這也是 spec §8 說
   mcp-server 可以安全指向 git-synced 的 store 唯讀副本的原因——但要注意
   `recordAccess()` 沒有包 try/catch，且是在 `searchMemory` 回傳結果**之
   前**、對每個命中結果同步呼叫（`query.ts` 的 `for (const h of top)
   index.recordAccess(...)` 迴圈跑完才 `return`）：如果指向的
   `index.db` 真的是唯讀掛載，`recordAccess` 一丟例外，整個
   `search_memory`/`get_memory` 呼叫會被 `server.ts` 的 `guarded()`
   包成 `isError: true` 的失敗回應，即使查詢本身已經找到結果——不是「統計
   悄悄漏記、結果照樣回傳」，而是連查詢結果都拿不到。這代表所謂「唯讀
   副本」若要真的可用，`index.db` 檔案本身仍必須可寫。
3. **`index.db` 併發靠 WAL + `busy_timeout`，不是額外的鎖機制。**
   `MemoryIndex` 建構子開檔案就下 `PRAGMA journal_mode = WAL` +
   `PRAGMA busy_timeout = 5000`（`distiller/ledger.ts`），mcp-server 和
   distiller 的排程 `distill run` 是各自獨立的 process、各自開一個
   `MemoryIndex` 實例指向同一個 `index.db`——WAL 模式讓讀者不擋寫者、寫者
   不擋讀者，`busy_timeout` 則讓短暫的寫入鎖衝突改成等待 5 秒重試而不是
   直接丟 `SQLITE_BUSY`。兩邊可以同時跑，不需要額外協調。
4. **CJK 查詢受 FTS5 tokenizer 限制，跟 distiller 章節「已知陷阱補充」
   第 2 條是同一個限制。** `memories_fts` 用預設 `unicode61` tokenizer，
   不會對中文/日文斷詞，所以 `search_memory({ query: "中文關鍵字" })`
   這類查詢的命中率會明顯比英文查詢差（一整段 CJK 字串會被當一個
   token，query 端的 `ftsQuery()` 切詞規則也一樣適用於 mcp-server 的輸入，
   因為兩邊共用 `MemoryIndex.search()`）。目前 lesson/trigger 預期以英文
   為主，影響有限，但如果之後有人餵中文 query 進 `search_memory`，記得
   這是已知限制，不是 bug。

## 文件對照表

| 主題 | 路徑 |
|---|---|
| 完整架構規格（三元件、資料流、格式契約） | `docs/superpowers/specs/2026-07-10-agent-memory-design.md` |
| collector 的 TDD 實作計畫（plan 1 of 3） | `docs/superpowers/plans/2026-07-10-collector.md` |
| distiller 的 TDD 實作計畫（plan 2 of 3） | `docs/superpowers/plans/2026-07-10-distiller.md` |
| 端到端可行性驗證（Spike A：匯出→抽取→驗證） | `docs/superpowers/SPIKE.md` |
| 記憶系統技術調研 | `docs/research/2026-07-10-memory-systems-landscape.md` |
| 蒸餾 pipeline 模式調研 | `docs/research/2026-07-10-distillation-pipeline-patterns.md` |
| collector 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY.md` |
| distiller 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY-distiller.md` |
| mcp-server 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY-mcp.md` |
| Plan 1/2/3 逐 task 進度與遺留項目 ledger | `.superpowers/sdd/progress.md` |

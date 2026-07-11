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
[distiller]  INGEST → TRIAGE(llm) → EXTRACT×N → VALIDATE → POOL-DEDUP → JUDGE → RECONCILE → COMMIT → PUBLISH   ← 已實作（見下方「Distiller」章節、「品質包」小節）
   │
   ▼
~/.agent-memory/store/memories/**.md, index.db (FTS5)
   │
   ├──► [distiller reflect]  跨 session、獨立排程的「事後整併」pass（cluster → insight
   │     /merge/none → promotion 掃描），不是上面 pipeline 的一個階段，是另一個進入點
   │     `distill reflect`（見下方「Reflect」小節）
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
./scripts/setup.sh [--backfill] [--schedule "0 3 * * *"] [--schedule-reflect "0 4 * * 0"]
                       # 一鍵部署（冪等）：裝 collector + 註冊 MCP（merge 不覆蓋）
                       # + 選配回灌歷史 + 選配 cron 夜跑（走 scripts/run-distill.sh，
                       # log 在 ~/.agent-memory/distill.log，exit code 會傳遞給 cron）
                       # + 選配「獨立排程」的 reflect cron（run-distill.sh --reflect-only，
                       # 用另一個 marker `# agent-memory-reflect`，兩條 cron line 互不影響）
bun install
bun test              # bun:test，collector/ + shared/ 全部單元測試
bun run typecheck      # tsc --noEmit
bun run build          # collector/plugin-entry.ts -> dist/agent-memory-collector.js
./scripts/install.sh   # build + 安裝進 opencode plugins 目錄 + broken-main 檢查
bun collector/backfill.ts [--db <path>] [--limit <N>]
bun run distill run [--project <slug>]   # 跑一次蒸餾 pipeline
bun run distill reflect [--project <slug>] [--dry-run]  # 跨 session 整併（見下方「Reflect」）
bun run distill reindex                  # 從 memories/ 重建 index.db
bun run distill review                   # 列出所有待人工審查的項目（quarantine + memories/）
bun run distill approve <id>             # 核准一筆待審項目（見下方「審查流程」）
bun run distill reject <id> [--reason "<text>"]  # 駁回一筆待審項目，永遠不刪除
bun run distill stats                    # 印出 status/type 統計 + 已處理 session 數
bun run mcp                              # 啟動 mcp-server（stdio）
bun run mcp:probe "<query>" | --stats    # 不經任何 MCP host，直接探測 server
scripts/run-distill.sh [--with-reflect | --reflect-only] [額外參數]
                       # cron-safe wrapper；預設只跑 distill run（沿用舊行為）；
                       # --with-reflect 跑完 run 再跑 reflect（同一份 log，exit code
                       # 取兩者較差者）；--reflect-only 只跑 reflect
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
INGEST → TRIAGE(llm) → EXTRACT×N → VALIDATE → POOL-DEDUP → JUDGE → RECONCILE → COMMIT → PUBLISH
```

1. **INGEST**（`transcripts.ts: scanSpool` + `isEligible`）— 掃描
   `transcripts/` spool，用 `(session_id, content_hash, pipeline_version)`
   當 ledger 主鍵判斷是否已處理過（`ledger.ts: isProcessed`）；只有距離
   `time_end` 已超過 `AGENT_MEMORY_IDLE_HOURS`（預設 6 小時）的 transcript
   才算 eligible。
2. **TRIAGE**（`pipeline.ts` 常數 `HARD_FLOOR_BODY = 80` + `triage.ts:
   llmTriage`）— 兩層過濾：不論哪個模式，body 少於 80 字元一律無條件跳過
   （不呼叫 LLM），仍會寫一筆 `n_candidates: 0` 的 ledger row 避免下次重
   掃。超過這條硬地板後，預設模式（`AGENT_MEMORY_TRIAGE=llm`）呼叫一次
   便宜的 LLM 判斷「這份 transcript 值不值得做完整抽取」；
   `AGENT_MEMORY_TRIAGE=heuristic` 則退回品質包之前的行為（`pipeline.ts`
   常數 `TRIAGE_MIN_BODY = 400`，純長度門檻，完全不呼叫 LLM）。詳見下方
   「品質包」小節的 fail-open 語義。
3. **EXTRACT ×N**（`extract.ts: buildExtractPrompt` + `EXTRACT_SCHEMA`）—
   對大模型丟整份 transcript body，要求嚴格 JSON array，六型分類見下
   方；`AGENT_MEMORY_EXTRACT_RUNS`（預設 2）次**獨立循序**呼叫，每次各自
   validate（見下），`salience` 低於 `AGENT_MEMORY_SALIENCE_MIN`（預設
   6）的項目在每次呼叫內就直接靜默丟棄（不算進 rejected 統計）。
4. **VALIDATE**（`extract.ts: validateCandidates`，純程式邏輯、不呼叫
   LLM，每個 run 各自驗證）— 逐欄位檢查必填/型別、`evidence[].message_id`
   必須對應到 transcript 裡真實存在的 `{#msg_id}` 錨點（`transcripts.ts:
   anchorsIn`；幻覺錨點直接 reject 該候選）、`lesson` ≤ 80 字，以及
   secret/高熵字串掃描（`scanSecrets`）——命中 secret 的候選不是被
   reject，是被送進 quarantine（見下）。
5. **POOL-DEDUP**（`pool.ts: dedupPool`）— 把 N 次 EXTRACT run 通過驗證
   的候選依 run 順序串接後去重合併，詳細規則見下方「品質包」小節。
6. **JUDGE**（`judge.ts: judgeCandidate`，`AGENT_MEMORY_JUDGES` 預設
   3）— pool 後每個候選再送去給 judge panel 重新評分，中位數共識取代
   extractor 自評的 salience，詳見下方「品質包」小節。
7. **RECONCILE**（`reconcile.ts`，Mem0 風格）— 用候選的 title+lesson 對
   `index.db` 做 FTS 查詢，抓 top 5 個 `status: active` 的既有 memory 當
   neighbor，再丟給 LLM 選擇恰好一種操作：`ADD` / `UPDATE` / `SUPERSEDE`
   / `NOOP`。`SUPERSEDE` 只會把舊 entry 標成 `status: superseded` +
   `superseded_by: <new_id>`，**從不刪除檔案**。**例外**：如果 SUPERSEDE
   鎖定的 target 是 `decision` 或 `convention` 型別（團隊決策/慣例，不是
   單純事實），不會自動套用——改成回傳 `SUPERSEDE_PENDING`，把候選寫成
   `status: quarantined`、`review: human_pending`、`supersedes:
   <target_id>` 的待審 entry 放進 `quarantine/`，target 完全不動，等人工
   跑 `distill approve`/`reject` 決定（細節見下方「審查流程」）。
8. **COMMIT**（`store.ts: writeEntry` + `ledger.ts: recordProcessed`）—
   寫入/更新 memory markdown 檔，並記一筆 ledger row（`n_candidates`/
   `n_committed`）。
9. **PUBLISH**（`pipeline.ts: renderIndexMd`）— 重新產生
   `store/INDEX.md`（依 project 分組、依 type 再依 confidence 降冪排
   序，附上 Quarantine 清單）。**注意：`renderIndexMd` 只在 `distill
   run` 結尾跑一次，`reindex`/`review`/`stats` 都不會重新產生
   INDEX.md。**

### 品質包（Quality Pack）：LLM triage / 自洽抽取 / judge 共識

三個功能全部**預設開啟**（quality-first），不用設任何 env var 就拿到較高
品質的行為；完整設計見
`docs/superpowers/specs/2026-07-11-quality-pack-design.md`。`pipeline.ts`
本身完全不讀 `process.env`——三個選項是 `PipelineOptions` 的
`{ triage, extractRuns, judges }` 欄位，只有 `cli.ts` 這一層負責從
`AGENT_MEMORY_TRIAGE` / `AGENT_MEMORY_EXTRACT_RUNS` / `AGENT_MEMORY_JUDGES`
解析並驗證範圍（壞值直接友善報錯、exit 1，不會靜默退回預設值）。

| Env var | 預設 | 驗證範圍 | 意義 |
|---|---|---|---|
| `AGENT_MEMORY_TRIAGE` | `llm` | `"llm"` \| `"heuristic"` | 見上方 TRIAGE 步驟 |
| `AGENT_MEMORY_EXTRACT_RUNS` | `2` | 整數 `[1, 5]` | EXTRACT 獨立呼叫次數 |
| `AGENT_MEMORY_JUDGES` | `3` | 整數 `[0, 5]` | judge panel 大小，`0` 或 `1` = 完全跳過 JUDGE 階段（單一 judge 沒有共識效果，等同關閉） |

**Triage fail-open 語義**（`triage.ts: llmTriage`）：LLM 呼叫失敗、回傳非
JSON、或 JSON 缺 `worth_extracting` 布林欄位，一律回傳 `{ worth: true,
failedOpen: true }`——`pipeline.ts` 看到 `failedOpen` 只印一行 stderr 提示
就讓 transcript 照樣進 EXTRACT，**不會**因為 gate 本身出問題而漏掉知識。
只有 LLM 明確回傳 `worth_extracting: false` 才真的算 triaged out（計入
`triagedLlm`，寫一筆 0-candidate ledger row）。

**Pool dedup 規則與 run-order 決定性**（`pool.ts: isDuplicate` /
`mergeCandidates` / `dedupPool`）：兩個候選視為重複，若且唯若「`type`
相同」且「（`title` 的 token-set Jaccard 相似度 `>= 0.6`）或
（`trigger` 完全相同）」；合併時 lesson 取較長者、`evidence` 依
`message_id` 去重聯集、`domain` 去重聯集、`salience` 取兩者最大值、
`volatile` 取 OR。`dedupPool` 是 greedy left-to-right：每個候選合併進
「第一個」跟它重複的既有 pool 成員——**這代表去重結果只有在 run 順序保持
一致時才是決定性的**，`pipeline.ts` 把 N 次 EXTRACT run 的結果嚴格按 run
index 順序串接（`allValid = allValid.concat(validated.valid)`）才能保證
可重現；secret 候選走同一套規則、獨立跑一個 pool（`dedupSecrets`），去重
後才個別寫進 quarantine。

**Judge 中位數與棄權**（`judge.ts: judgeCandidate` / `medianConsensus`）：
POOL-DEDUP 後（絕不對還沒過 schema 驗證或還是重複的候選浪費 judge 呼
叫）、RECONCILE 前，對每個候選跑 `AGENT_MEMORY_JUDGES` 次獨立循序 LLM
呼叫，各自要求 `{"salience": n, "reason": "…"}` 的嚴格 JSON。單次呼叫失
敗、JSON parse 失敗、或 `salience` 不是 `[0,10]` 內的數字，都視為該
judge**棄權**（不計入 votes，不拋錯讓整個候選失敗）。若全部 judge 都棄
權，直接 fallback 回 extractor 自評的 `salience`
（`usedFallback: true`）；否則取所有有效票的中位數（`medianConsensus`：
奇數取中間值，偶數取「較保守」的下中位數，即 `sorted[n/2 - 1]`）。
consensus 分數低於 `AGENT_MEMORY_SALIENCE_MIN` 的候選在這一步被靜默丟
棄——跟 EXTRACT 階段自評分數的丟棄語義一致，不算進 rejected 統計。
`AGENT_MEMORY_JUDGES=0` 或 `1` 直接短路（`judge.ts: judgeCandidate` 的
`judges <= 1` 判斷）：不打任何 LLM，回傳
`{ salience: c.salience, panel: 0, voted: 0, usedFallback: true }`，效果
跟「全員棄權」完全一樣，只是零延遲零花費。單一 judge（N=1）沒有共識可
言，故與 N=0 同樣視為關閉，這是 spec 明訂的語義，不是實作疏漏。

**計數器變化**（`RunSummary`）：新增 `poolRaw`（N 次 run 合併前的候選總
數，含 secrets）、`triagedLlm`、`triagedHeuristic`（依實際觸發的 triage
模式分別計數）；`triagedOut` 保留下來當作兩者的**總和**，向下相容既有
CLI 輸出格式與舊測試斷言。`distill run` 印出的一行摘要（`cli.ts`）已接上
這三個欄位——`(scanned S, eligible G, already-done D, triaged T, pool
P->C, triaged llm:L/heur:H)`，`P->C` 是 `poolRaw`/`candidates`（去重前/
後），`L`/`H` 是 `triagedLlm`/`triagedHeuristic`（Plan 7 final wave 補上，
之前這三個欄位雖然存在於 `RunSummary`、也有測試覆蓋，但沒接進 CLI 輸出）。

**每筆候選的 judge provenance 記在 entry 的 `notes` 上，不是
`extractor` 標籤。** `pipeline.ts` 的 JUDGE 階段（`judges > 1` 才會跑，
見上）對每個保留下來的候選組出 `judgeNote`（`judged: median <m>
(<voted>/<panel>)`，或全員棄權時 `judged: fallback self-score <s>
(0/<panel>)`），掛在 `Candidate.judgeNote`（`extract.ts` 新增的內部限定
欄位，`EXTRACT_SCHEMA` 不含它——LLM 永遠不會自己產生這個欄位）。
`reconcile.ts` 的 `entryFromCandidate`（ADD/SUPERSEDE 新建 entry 用）和
`applyUpdate`（UPDATE 用）都會把 `judgeNote` 以跟其他 note 一樣的日期前綴
格式附加到 `notes` 陣列；沒被 JUDGE 評過分的候選（`judges` 為 0 或 1、或
是完全不經過 JUDGE 就直接進 quarantine 的 secret 候選）則完全不會有這則
note。`provenance.extractor` 字串本身不再帶 ` judges:N` 後綴——那個後綴
曾經是 run-level 的，沒辦法區分「這個候選真的被 judge 評過」跟「只是同一
個 run 裡剛好 judges>0」，也曾經誤標到從沒經過 JUDGE 的 secret quarantine
entry 上（見下方已知注意事項的舊版本），改成 per-entry note 後這個問題
本身就不存在了。

**已知注意事項：**

1. **`JUDGE_SCHEMA` 的 `required: ["salience", "reason"]` 只是 prompt
   steering 契約，不是 runtime 強制驗證。** 這個 schema 物件會整包傳給
   `llm.complete({ schema: JUDGE_SCHEMA })`，在 vLLM guided-decoding
   backend 下確實會被引擎拿去強制輸出形狀；但 `judge.ts:
   judgeCandidate` 實際 parse 回應時**只檢查 `salience` 是不是
   `[0,10]` 內的數字**，完全沒有檢查 `reason` 欄位是否存在或是字串——
   一個缺 `reason` 但 `salience` 合法的回應照樣被接受並計入 votes。跟
   `EXTRACT_SCHEMA`/`TRIAGE_SCHEMA` 的角色一致：對支援 guided decoding
   的 backend（vLLM）是硬約束，對不支援的 backend（`opencode-run`）純
   粹是 prompt 裡的措辭提示，程式碼永遠只驗證真正用到的欄位。

（原本記在這裡的「`judges` 後綴同時誤標到 secret provenance 上」的已知
瑕疵，隨 Plan 7 final wave 把 judge provenance 從 run-level 的
`extractor` 後綴改成 per-entry 的 `judgeNote` 而不再存在——secret 候選
從不經過 JUDGE，自然也就不會有 `judgeNote`，見上方段落。）

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

### 審查流程（review / approve / reject）

這一節關的是原設計留下的**三個斷頭路**（`docs/superpowers/specs/
2026-07-10-review-loop-cjk-design.md` §1）：

1. quarantine 只進不出——`distill review` 能列出待審項目，但沒有指令能
   放行或駁回它們。→ 現在有 `distill approve <id>` / `distill reject
   <id> [--reason "…"]`（`reviewops.ts`）。
2. confidence 公式裡的 `+0.2 human_approved` 項在系統裡完全沒有觸發
   點。→ 現在 `approveEntry` 就是唯一的觸發點（見下方 confidence 重算）。
3. SUPERSEDE 打到 `decision`/`convention` 型 memory（團隊政策）時會**立即**
   自動生效，中間沒有人看過。→ 現在 `reconcile.ts` 攔截這兩型的
   SUPERSEDE，改成待審（見上方 RECONCILE 步驟的例外說明）。

Secret/高熵字串命中的候選、以及被攔截的 decision/convention SUPERSEDE
提案，都不會被丟棄，而是用共用的 `distiller/quarantine.ts:
writeQuarantineEntry()` 寫成獨立檔案到 `store/quarantine/<id>.md`（id 跟
既有檔案或 index 已知 id 撞名時用 `-2`/`-3` 慣例改名，同時把最終 entry
upsert 進 index）。

**`bun run distill review`** 會做兩件事，兩邊都列出來、依 id 去重：
1. 掃 `memories/` 底下所有 entry，找出 `review === "human_pending" &&
   status !== "archived"` 的（人工手動把項目搬進 `memories/` 但還沒核准
   的情況）。
2. 直接掃 `quarantine/` 目錄下的所有 `.md` 檔（pipeline 正常產生
   quarantine 的路徑，也包含 SUPERSEDE_PENDING 提案）。

印出 `<id> — <title> (<最後一則 note>)`；壞掉（parse 失敗）的檔案不會讓
整個列表噴掉，只會印到 stderr 說 `skipping corrupt entry: <path>`。

**`distill approve <id>`**（`reviewops.ts: approveEntry`）：
1. 前置檢查：id 必須存在（`index.getById`）且 `review === "human_pending"
   && status !== "archived"`，否則丟出「not found」/「not pending」錯誤，
   CLI 印友善訊息、exit 1。
2. 設 `status: active`、`review: human_approved`，重算 confidence：
   `computeConfidence({ sessions: <去重後的 evidence session 數>,
   humanApproved: true, contradicted: false })`（這是 `+0.2` 項目**唯一**
   被觸發的地方），附一則 `<date>: approved by human` note。
3. 如果原檔案在 `quarantine/` 底下：搬到 `memories/<project>/<id>.md`；
   目的地撞名（檔案已存在，或 index 裡已有一個路徑不同的同 id 項目）就
   用 `-2`/`-3` 慣例改 id 後再搬，原本佔用該路徑的檔案完全不動。
4. 如果 entry 有 `supersedes: <target_id>`：**在改名/搬移之後**才去
   tombstone target（`status: superseded`、`superseded_by: <approve 後
   的最終 id>`），確保 `superseded_by` 記的是改名後的 id，不是改名前的
   舊 id；如果 target 已經在 index 裡找不到（drift），approve 仍然成功，
   只是回傳一個 `supersede target <id> not found — approved without
   tombstoning` 的 warning（CLI 印到 stderr）。

**`distill reject <id> [--reason "<text>"]`**（`reviewops.ts:
rejectEntry`）：同樣的前置檢查；設 `status: archived`，附
`<date>: rejected by human — <reason，預設 "not specified">` note。
**檔案原地不動**（不搬、不刪）——`status: archived` 本身就足以讓它從
`distill review` 的清單和所有查詢路徑（`search_memory`）消失；`reindex`
仍然會掃到它（archived 不等於從磁碟消失，只是不再是 pending / active）。

**`supersedes` 欄位語義**：`MemoryEntry` 上唯一允許「缺欄位」的
frontmatter 欄位——serializer 永遠寫這一行，但 parser 讀到缺這行的舊檔會
預設成 `null`（相容既有 16 份 store 檔案），型別錯（例如塞數字）仍然照
strict 規則丟例外。這個欄位只在兩個地方被寫入非 null 值：(a)
`reconcile.ts` 攔截 decision/convention SUPERSEDE 時，把待審 entry 的
`supersedes` 設成被鎖定的 target id；(b) 沒有其他寫入路徑會動它。
`approveEntry` 讀這個欄位決定要不要執行第 4 步的 tombstone；`rejectEntry`
完全不理會它——拒絕一個 SUPERSEDE_PENDING 提案只是把提案本身歸檔，
`supersedes` 指到的舊 target 從頭到尾沒被碰過。

**decision/convention 攔截規則**：`reconcileCandidate` 的 SUPERSEDE 分支
裡，只要 `target.entry.type === "decision" || target.entry.type ===
"convention"` 就會走攔截路徑，回傳 `op: "SUPERSEDE_PENDING"`（`pipeline.ts`
把它算進 `summary.quarantined`，**不算進** `n_committed`）；其餘四型
（`root_cause`、`pitfall`、`know_how`、`workflow`）維持原本的自動
SUPERSEDE，沒有審查步驟——這四型是事實性知識，不是團隊政策，沒有「一句
話翻案」的風險。

**Worked example（決策翻案的完整流程）**：已核准的 `decision` memory
`mem_20260710_8cd55e`（「禁用 useful skew」）目前 active。之後某個 session
主張要解禁，RECONCILE 判定 SUPERSEDE，但因為 target 型別是 `decision`，
不會自動套用——改成在 `quarantine/` 產生一筆
`supersedes: mem_20260710_8cd55e` 的待審 entry，note 寫
`pending review — proposes to supersede mem_20260710_8cd55e: …`。

```bash
bun run distill review
# mem_20260711_a1b2c3 — Allow useful skew (pending review — proposes to supersede mem_20260710_8cd55e: …)

bun run distill reject mem_20260711_a1b2c3 --reason "still banned"
# rejected mem_20260711_a1b2c3
```

拒絕之後提案本身變成 archived，`mem_20260710_8cd55e` 從頭到尾沒被動過，
agent 查詢「useful skew」得到的仍然是原本「禁止」的答案。如果改成
`approve` 這筆提案，`mem_20260710_8cd55e` 才會被 tombstone
（`status: superseded`、`superseded_by: mem_20260711_a1b2c3`），新 entry
變成 active 的答案。

### Reflect（跨 session 整併，`distiller/cluster.ts` + `distiller/reflect.ts`）

`distill run`一次只看一份 transcript；`distill reflect` 事後掃**整個
store**，找單一 session 蒸餾看不到的跨 session 模式：

```bash
bun run distill reflect --dry-run            # 一定要先跑這個——見下方 SOP
bun run distill reflect [--project <slug>]
```

**判斷邏輯：先確定性 clustering，再每個 cluster 呼叫一次 LLM（judge-gated）。**
`cluster.ts` 先用 `domain` tag 分組，組內再用 `title + trigger` 的 token
Jaccard 相似度（門檻 `0.35`，沿用 `pool.ts` 去重的 tokenizer）配
union-find 找連通分量；size < 2 丟棄，size > 12 只留信心度最高的
members；輸出依 cluster 大小由大到小排序（決定性 tie-break）。每個 cluster
交給 LLM，只能選一個 op：

1. **`insight`**——cluster 揭露了任何單一 member 都沒講出的高階模式。建立
   一筆新的 `semantic` entry（`review: auto`，所以要跟一般抽取候選一樣過
   judge gate：median salience ≥ `AGENT_MEMORY_SALIENCE_MIN`），note 寫
   `derived from: <排序後的 member id 清單>`，evidence 是所有 member
   evidence 的聯集（依 session 去重）。
2. **`merge`**——兩個以上 member 講的是同一件事、只是用詞不同（RECONCILE
   當初漏掉的近重複）。非 policy 的 absorb member 走**跟 RECONCILE 完全一樣
   的 supersession 機制**（`applySupersession`，從 `reconcile.ts` 抽出來
   共用）——直接 tombstone，evidence 併入 keep，keep 的 confidence 照
   RECONCILE `applyUpdate` 同一條公式（`computeConfidence`，distinct
   session 數）重算。只要 keep 或任一 absorb member 是
   `decision`/`convention` 型（policy gate），該 absorb 就不會直接套用，
   而是併進**單一一筆** enriched-keep 待審提案：內容是 keep 本身欄位 +
   所有 policy-routed absorb member 的 evidence 聯集（依 session
   去重）+ 重算的 confidence，`supersedes: <keep id>`、
   `absorbs: [<absorb id 清單>]`、`promoted_from` 明確設 `null`。**`approve`**
   這筆提案時（`reviewops.ts: approveEntry`）除了照常 tombstone
   `supersedes` 指到的 keep，還會**額外** tombstone `absorbs`清單裡的每一個
   id，三者的 `superseded_by` 都指向最終批准的 id——active set 收斂成
   唯一一筆 enriched entry，不會出現 keep 跟批准後的副本同時 active
   的重複（這是 v1 clone-based 設計的 convergence bug，clone
   supersedes 指向 absorb id、keep 本身不被 tombstone，批准後
   `{keep, clone}` 兩筆同時 active，下次 reflect 又把它們重新聚成一類，
   永遠循環提案）。走 `distill review`/`approve`/`reject`，跟上面
   「決策翻案」worked example 同一套審查佇列。
3. **`none`**——cluster 只是主題巧合，不做事。

Cluster pass 跑完後，reflect 還會做一次**promotion 掃描**：任何
project-scoped 的 active entry，只要 evidence 橫跨 ≥ 2 個不同 project（或
本來就帶著 RECONCILE 留下的 `"promotion candidate"` note），就會產生一份
`global` scope 的待審副本（`status: quarantined`、`review: human_pending`、
`promoted_from: <來源 id>`），一樣走 `distill review`/`approve`/`reject`。
**`approve`** 一筆 promotion 副本時，會在來源 entry 上補寫一則
`promoted to <最終 id>` 的回寫 note（`reviewops.ts: approveEntry`；來源
entry 若已經 drift 掉找不到，approve 仍然成功，只是印一個 warning，跟
`supersedes` 缺失時的處理邏輯一致）。

> **已知限制（caveat）**：「≥ 2 個不同 project」這個訊號是拿每筆 evidence
> 的 session id 去比對即時 transcript spool（`cfg.transcriptsDir`）反查出
> project——它本身沒有獨立記住「這個 session 屬於哪個 project」。如果有
> retention job 清掉舊 transcript，這半個訊號會對舊 evidence 悄悄退化成
> 0（RECONCILE 留下的 `"promotion candidate"` note 訊號不受影響，永遠是
> 保底路徑——兩個訊號任一觸發都會 promote）。

**治理繼承——reflect 沒有發明任何新的治理規則**：每個 reflect 會做的
mutation 都走**既有**機制：insight 跟抽取候選一樣過 judge gate；merge 走
RECONCILE 同一支 supersession 程式碼（decision/convention 待審 gate 因此
免費繼承）；promotion 跟 secret-scan 命中一樣寫進 quarantine 待審。reflect
沒有任何一條路徑能繞過抽取/RECONCILE 就能繞過的審查佇列。

**Stateless（可以隨時重跑）**：reflect 本身不帶任何跨 run 的狀態，冪等性
完全從磁碟上現有的資料推導：cluster 重新形成時，只要有 active entry 的
notes 已經帶著一模一樣的 `derived from: <ids>` tag 就跳過；merge 只要
absorb members 都已經不在就跳過（直接吸收的路徑）；全走 policy 待審路徑
的 merge（每個 absorb 都是 policy-routed）則是找 `supersedes === keep id`
的既有待審提案，有就跳過（**不是**按 absorb id 找——enriched-keep 提案的
`supersedes` 指向 keep，不是任一 absorb）；promotion 只要有任何非
archived entry 已經帶 `promoted_from: <來源 id>` 就跳過。緊接著
`distill reflect` 完整跑一次後立刻重跑，理論上應該全部 skip、零新檔案
——**approve 一筆 policy-merge 提案之後**也是如此：keep 跟每個 absorb
都被 tombstone，active set 只剩下批准後的唯一一筆 enriched entry，沒有
可以重新聚類的一對，reflect 自然收斂成零新 op（見下方「已知注意事項」）。

> **已知注意事項（rejected 提案會在下次 reflect 重新出現）**：`reject`
> 一筆 merge 或 promotion 提案，語意是「這一次不要」，不是「永遠不要」。
> quarantine 副本被 `reject` 後狀態變成 `archived`，本身不會再被批准；但
> 觸發這次提案的**條件**（keep/absorb 的 domain + title/trigger 相似度、
> 或 evidence 橫跨 ≥2 project 的訊號）如果還在，下一次 `distill reflect`
> 一樣會重新判斷、重新產生一筆**新的**待審提案（新 id，不是被 reject 的
> 那筆復活）。如果確定不想再被提案，要處理掉**來源條目**的觸發因素本身
> ——例如把其中一個 member 手動 archive、改寫 title/trigger 讓相似度降到
> 門檻以下、或人工修掉 `"promotion candidate"` note——單純 `reject` 不會
> 讓提案「消失」，只是暫時把這一版擋下來。

**Dry-run-first SOP**：`--dry-run` 照樣算出並印出每個 op（cluster 判斷還是
會呼叫 LLM——dry-run 只跳過**寫入**這一步），但對 store **零寫入**。一定
先跑 `--dry-run` 看過印出的計畫，再跑正式的：

```bash
bun run distill reflect --dry-run   # 看計畫，store 完全沒被動
bun run distill reflect             # 正式套用
bun run distill review              # 有沒有東西進了待審佇列？
```

`reflect` 印出的一行摘要，例如：

```
reflect done: 2 insights, 1 merges (1 pending review), 1 promotions queued, 5 clusters examined, 3 skipped, 0 errors
```

Exit code：`0` 成功、`1` 用法/設定錯誤（unknown flag、`--project` 缺值、
env 值不合法）、`2` 有 cluster 出錯（LLM 回傳格式壞掉）——其餘 cluster
還是會跑完。

**排程**：reflect 適合排得比夜跑的 distill 更疏（它整併的是已經蒸餾過的
session，沒有理由每次新 transcript 進來就跑一次）——用
`./scripts/setup.sh --schedule-reflect "0 4 * * 0"` 裝一條**獨立**的 cron
line（marker `# agent-memory-reflect`，跟 distill 的 `# agent-memory-distill`
互不干擾，各自重跑都是「取代同 marker 那一行」的冪等語意）；也可以用
`scripts/run-distill.sh --with-reflect` 在同一條 cron line 裡先跑 run 再跑
reflect（同一份 log，exit code 取兩者較差者）。`AGENT_MEMORY_JUDGES` /
`AGENT_MEMORY_SALIENCE_MIN` 跟 `distill run` 共用，reflect 沒有自己專屬的
env var。

### CJK 檢索（trigram FTS）

`memories_fts` 的 tokenizer 從預設 `unicode61` 換成 `trigram`
（`ledger.ts` DDL：`tokenize = 'trigram'`），解決「已知陷阱補充」原本第 2
條記錄的 CJK 斷詞問題——`unicode61` 會把一整段連續 CJK 字元當成單一
token，`trigram` 則是逐字元切三連字（trigram）建索引，讓「查詢字串是既有
文字的子字串」這件事對 CJK 也成立，不需要真的斷詞。

**Migration（`MemoryIndex` 建構子）**：讀 `PRAGMA user_version`；
`< 2`（舊 db，包含從未設過 version 的 v0）→ drop 掉舊的 `memories_fts`、
用新 DDL 重建（清空的 FTS 表）、設 `user_version = 2`，並且如果
`memories` 表本來就有資料，把公開唯讀欄位 `ftsRebuildNeeded` 設成
`true`；全新 db 直接以 `user_version = 2` 起始，`ftsRebuildNeeded` 恆為
`false`。**index.db 本來就是可重建的衍生快取，這次 migration 沒有資料
遺失風險**——遺失的只是 FTS 索引內容，不是 memory 檔案本身。

**自動重建**：三個持有 storeDir 的進入點——`distiller/cli.ts`（透過內部
`openIndex()` helper）、`mcp-server/main.ts`、`mcp-server/probe.ts`——都在
建立 `MemoryIndex` 之後檢查 `ftsRebuildNeeded`，是 `true` 就印一行
`agent-memory: fts schema upgraded — rebuilding index from <storeDir>` 到
stderr，然後呼叫 `index.rebuildFrom(storeDir)`。升級後**第一次**執行
`distill stats`（或任何指令、或啟動 mcp-server）會印這行通知；因為
`rebuildFrom` 跑完後 db 已經在 `user_version = 2`，**第二次**執行同樣的
指令就不會再印，也不需要手動跑 `reindex`。

**查詢規則（`MemoryIndex.search()`）**：把 query 依非文字/數字字元切
token 後，用 `[...t].length`（code point 數，CJK 一字一個 code point）分
成兩組：
- **長 token（≥ 3 code points）存在**→ 只用這些長 token 走原本的
  `MATCH` 路徑（bm25 排序不變）。一個 3 字以上的 CJK 連續字串（例如
  `時序收斂`、`收斂技巧`）本身就滿足 trigram 索引的最小匹配單位，可以
  查到含有這段字的 lesson，即使查詢字串只是 lesson 裡的子字串。
- **沒有任何 token 到 3 code points**（例如純 2 字 CJK 查詢 `時序`）→
  退回 `LIKE` fallback：對每個短 token 各自組
  `(f.title LIKE ? OR f.trigger LIKE ? OR f.lesson LIKE ? OR f.domain LIKE
  ?)`（`%tok%`，`%`/`_` 這兩個 LIKE 萬用字元會先跳脫），逐 token 用 `OR`
  接起來，套用跟 MATCH 路徑相同的 metadata 篩選條件，依
  `m.confidence DESC` 排序，`score` 固定填 `0`（fallback 完全沒有相關度
  分數可用，排序交給 confidence）。`首都`（store 裡沒有任何內容含有這兩
  字）回傳空陣列，不噴例外。
- **混合查詢（長 + 短 token 都有）忽略短 token**：只要有任何 ≥3
  code-point 的 token，就整條走 MATCH 路徑、短 token 完全不參與查詢——
  這是刻意的行為，不是漏洞：不要預期一個 2 字 CJK token 能在混了長
  token 的查詢裡額外貢獻命中率。
- **英文子字串副作用**：因為 trigram 是逐字元索引而非逐詞，英文查詢也會
  多出子字串匹配能力，例如查 `parasitic` 現在也會命中含
  `parasitics` 的內容——這是溫和的 recall 提升，不是 regression，bm25
  排序照常套用；既有的英文搜尋測試就是這個副作用的迴歸網。

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
2. **（已解決，trigram FTS）SQLite FTS5 預設 tokenizer（unicode61）不會
   斷詞 CJK。** 原本 `memories_fts` 沒有另外指定 tokenizer，中文/日文這
   類沒有空白分隔的文字整段會被當一個 token；`memories_fts` 現在改用
   `tokenize = 'trigram'`（見上方「CJK 檢索（trigram FTS）」章節），
   3 字以上的 CJK 查詢直接走 MATCH 就能命中包含它的長字串。**剩下的限制**：
   純 2 字 CJK 查詢（沒有任何 token 到 3 code points）走 LIKE fallback，
   分數固定 0、排序完全靠 confidence；混合查詢裡的短 token（< 3 code
   points）會被忽略，不會額外貢獻命中率。既有 index.db 會在下次開啟時
   自動 migration + 重建（`ftsRebuildNeeded`，見同一章節），不需要手動
   介入。
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
   item 4 曾經誤寫成兩者等價，已更正）。**fallback（filescan）模式下
   這條坑的鏡像版本**：`ledger.jsonl`（見下方「SQLite 可選模式」章節）
   同樣是「非投影」資料——它跟 sqlite 的 `processed_sessions` 表一樣，
   不是從 `memories/`/`quarantine/` 的 markdown 內容衍生出來的，
   `FileScanIndex.rebuildFrom` 也是 no-op（filescan 模式沒有索引可
   重建，markdown 本身就是索引）。換句話說：**不管哪個模式，冪等
   ledger 都是「唯一真相只活在它自己的檔案裡」的資料**——sqlite 模式
   砍 `index.db`、fallback 模式砍 `ledger.jsonl`，效果等價：memory
   條目本身都還在（markdown 沒事），但下次 `distill run` 會把所有
   session 當成沒處理過，重新跑一次完整抽取。備份/搬遷 store 時，
   這兩個檔案（或其中一個，視當時執行模式而定）要跟 `memories/`/
   `quarantine/` 一起備份，不能只備份 markdown 目錄。

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
4. **（已解決，trigram FTS）CJK 查詢受 FTS5 tokenizer 限制，跟
   distiller 章節「已知陷阱補充」第 2 條是同一個限制，也是同一次改動
   解決的。** `memories_fts` 現在用 `trigram` tokenizer（見 Distiller
   章節「CJK 檢索（trigram FTS）」），`search_memory({ query:
   "中文關鍵字" })` 只要查詢裡有任一 token 到 3 code points 就能正常
   MATCH 命中；mcp-server 和 distiller 共用同一支
   `MemoryIndex.search()`，行為完全一致。**剩下的限制**：純 2 字 CJK
   查詢（例如 `search_memory({ query: "時序" })`）會走 LIKE fallback、
   分數固定 0，混合查詢裡的短 token 會被忽略——這兩點是刻意的行為，
   不是 bug，細節見 Distiller 章節。

## SQLite 可選模式（sqlite-optional）

設計動機記在 `docs/superpowers/specs/2026-07-11-sqlite-optional-design.md`：
公司內部部署環境不一定支援 SQLite（`bun:sqlite` native binding 沒編、限制
掛載的檔案系統不支援 file locking…），所以 markdown store 必須維持「自足」
——`index.db` 從「唯一索引」降格成「選配的加速器」，開機時 probe 一次，
不可用就自動降級並印警告，不需要任何手動設定。

### 原則：「markdown 為主、db 為輔」

Markdown 檔案本來就是 source of truth；今天的 `index.db` 除了是這些
markdown 的**投影（derived projection）**之外，還多背了兩份**非投影**的
簿記資料：冪等 ledger（`processed_sessions` 表）跟 access 統計。這份規格
把每一個依賴 db 的功能都改成三選一：(a) 退化成 markdown-scan 實作、(b) 退
化成純檔案實作（ledger.jsonl）、(c) 直接關掉並印警告——對照表見下方
「逐功能降級表」。

### 架構（`distiller/indexes.ts`）

```
probeSqlite(storeDir, env) → SqliteProbe { ok, reason? }
        │
        ▼
openMemoryIndex(storeDir, probe, opts?) → MemoryQuery
        │
   ┌────┴────┐
   ▼         ▼
SqliteIndex  FileScanIndex
(包 MemoryIndex，  (markdown scan + FileLedger，
 行為完全不變)      無快取、每次呼叫重新掃磁碟)
```

- `probeSqlite`（`shared/sqliteProbe.ts`）：`env.AGENT_MEMORY_NO_SQLITE ===
  "1"` 直接短路回傳 `{ ok: false, reason: "disabled by
  AGENT_MEMORY_NO_SQLITE" }`（不碰檔案系統）；否則在 `storeDir` 底下開一個
  `.sqlite-probe.tmp`，設 `WAL`、建表、寫一筆、讀回來驗證、關閉，`finally`
  裡盡力刪掉 `.tmp`/`-wal`/`-shm` 三個探測檔；任何一步丟例外都回傳
  `{ ok: false, reason: String(error) }`。**每個進入點（`distiller/cli.ts`、
  `mcp-server/main.ts`、`mcp-server/probe.ts`、`eval/run.ts`）每個 process
  只 probe 一次**，結果往下傳，不會中途重 probe。
- `openMemoryIndex(storeDir, probe, opts)`：`probe.ok` → `new
  SqliteIndex(dbPath)`（薄包裝，逐方法委派給既有的 `MemoryIndex`，`ledger.ts`
  完全沒改）；否則印一次警告（見下）、回傳 `new FileScanIndex(storeDir,
  warn)`。**「每個進入點每個 process 只印一次警告」是進入點自己的責任**——
  factory 只保證「這次呼叫印一次」，進入點保證自己只呼叫一次 factory。
- `MemoryQuery` 是兩個實作共用的介面（`search`/`getById`/`upsertEntry`/
  `removeEntry`/`stats`/`recordAccess`/`accessStats`/`ledger`/
  `rebuildFrom`/`close`/`mode`），所有 consumer（`pipeline.ts`、
  `reconcile.ts`、`reviewops.ts`、`quarantine.ts`、`cli.ts`、
  `mcp-server/*`、`eval/run.ts`）都從 `new MemoryIndex(...)` 改成吃這個
  interface；原本直接呼叫 `index.isProcessed(...)`/
  `index.recordProcessed(...)` 的地方改成 `index.ledger.isProcessed(...)`/
  `index.ledger.recordProcessed(...)`。

**`ftsRebuildNeeded` 是選配欄位，不是判別聯集（discriminated union）。**
`MemoryQuery.ftsRebuildNeeded?: boolean` 只有 `mode === "sqlite"` 時才有意
義（filescan 模式沒有 FTS schema 可以 migrate，恆為 `undefined`）。這是
Task 5 刻意的取捨：TypeScript 不會單靠一個 sibling 的字面型別欄位
（`mode`）去窄化另一個 optional 欄位的型別，要做到編譯期窄化必須把
`MemoryQuery` 拆成 `SqliteQuery | FileScanQuery` 的判別聯集，但那會連鎖
影響每一個 consumer 的型別簽名。權衡之下選了「選配欄位 + 執行期 guard」，
所有進入點（`cli.ts`、`mcp-server/main.ts`、`mcp-server/probe.ts`）在呼叫
`rebuildFrom` 前都明確寫 `index.mode === "sqlite" && index.ftsRebuildNeeded`
兩個條件都成立才動作——這是刻意接受的型別不夠精確，不是遺漏。

### 逐功能降級表

| db 功能 | 呼叫方 | fallback（filescan）行為 | 是否真的少了東西 |
|---|---|---|---|
| FTS 搜尋（bm25 + trigram） | `search_memory`、RECONCILE neighbor 查詢、`distill review` | markdown scan：走 `listEntryPaths` + `parseEntry`，逐 token 算 `hits = Σ(title×3 + trigger×2 + lesson×1 + domain×2)` 的大小寫不敏感子字串出現次數，`score = -hits`，0 分排除；同樣的 status/confidence/project/type 篩選語意 | **排序訊號變粗**：不是 bm25，是確定性的關鍵字計分——見下方「search 為 substring 計分」補充 |
| `getById` | `get_memory`、`reviewops`、quarantine 改名去重 | 檔名掃描：`<id>.md` 同時在 `memories/` 跟 `quarantine/` 兩棵樹找 | 沒有，只是從 O(1) 變 O(n)，wiki 量級無感 |
| `stats`（byStatus/byType） | `distill stats`、`memory_stats` | markdown scan 累加 | 沒有，數字跟 sqlite 模式完全一致（見 VERIFY item 3/4） |
| 冪等 ledger（`processed_sessions`） | distiller INGEST 判斷 session 是否已處理 | `<storeDir>/ledger.jsonl`（見下方專節） | 沒有，正確性保證不變，只是換了儲存形式 |
| `sessions`/`lastProcessedAt` | `distill stats`、`memory_stats` | 從 `ledger.jsonl` 讀 | 同上；但如果 `ledger.jsonl` 從沒被寫過（例如這個 store 一直只在 sqlite 模式跑），這兩個值就是 `0`/`null`，跟 sqlite 模式的 `processed_sessions` 計數不會相等——這不是 bug，是兩份**各自獨立**的簿記資料，見 VERIFY item 3 的實測記錄 |
| access 統計（`recordAccess`/`accessStats`） | `search_memory`/`get_memory` 的排序回饋訊號 | **直接關掉**：`recordAccess` no-op，`accessStats` 回傳 `null`，`stats().accessAvailable = false` | **真的少了**——filesystem 沒有原生方式追蹤每筆 access 次數，這是目前唯一無法用純檔案手段補回來的能力。排序公式（confidence + recency boost）照常運作，只是少了「這筆到底被查過幾次」這個 reinforcement 輸入 |
| `rebuildFrom` / `distill reindex` | `distill reindex` | no-op，印 `markdown is the store — nothing to rebuild (filescan mode)`，exit 0 | 沒有，filescan 模式沒有衍生索引需要重建——markdown 本身就是索引 |
| CJK 搜尋（例如 `時序`） | `search_memory` | 原生子字串比對，不需要 tokenizer，任何長度都行 | 沒有，甚至比 sqlite 模式的「3 字以上走 trigram MATCH、2 字走 LIKE」規則更單純一致 |

### `search` 為 substring 計分，不是 bm25（補充）

`FileScanIndex.search()` 的排序訊號跟 sqlite 模式的 bm25 **不是同一種東
西**，寫查詢工具或除錯排序時要記得：filescan 模式沒有「相關度分數」的概
念，只有「命中次數加權」——出現越多次（尤其在 title/domain 這種加權高的
欄位）分數越好，但不像 bm25 會考慮詞頻飽和（term frequency saturation）
或文件長度正規化。兩種模式的排序在同一個 store 上**不保證產生一模一樣的
名次**，只保證语意上都合理（都會把 query token 命中最多的 entry 排在前
面）。`searchMemory()` 外層的 confidence/recency rank-position boost 對兩
種模式一視同仁地套用在各自的排名之上。

補充：filescan 模式下因為排序訊號不同（substring 計分 vs bm25），
RECONCILE 判斷「這是不是同一筆記憶」時取到的 neighbor top-5 成員可能跟
sqlite 模式不完全一樣，偶爾會把原本該是 UPDATE 的一筆誤判成 ADD——這個
情況被同一套「換模式時也會用到」的 reconcile-dedupe 保證涵蓋，不是新的
正確性風險。

### filescan 模式無 access 統計 → 排序少一個訊號（補充）

因為 `accessAvailable: false`，`search_memory` 的排序公式在 filescan 模式
下實際上只剩 confidence + recency 兩個信號在調整 bm25/substring 排出來的
名次；access 統計原本並不直接進排序公式（`query.ts` 目前的公式本來就沒有
用到 `access_count`），所以嚴格說「排序少一個訊號」指的是**未來想加
access-based 排序時，filescan 模式永遠沒有這個訊號可用**，不是現有排序
公式今天就依賴它——這點在寫任何未來想用 access 次數調整排序的功能之前要
先確認。

### `ledger.jsonl` 語義

`FileLedger`（`distiller/indexes.ts`）是 sqlite `processed_sessions` 表在
filescan 模式下的替代品：

- 路徑固定 `<storeDir>/ledger.jsonl`，一行一筆 JSON record：`session_id`、
  `content_hash`、`pipeline_version`、`extractor_model`、`processed_at`、
  `n_candidates`、`n_committed`——跟 sqlite 表同一組欄位。
- **單一寫入者**：只有 distiller 的 `recordProcessed` 會 append，append-only
  （`appendFileSync`），沒有任何路徑會改寫或刪除既有行。
- **torn-line 容忍**：載入時逐行 `JSON.parse`，**只有最後一行**解析失敗會
  被靜默容忍（crash 剛好卡在一次 append 中途的典型症狀），其他行解析失敗
  會被跳過並印一則聚合 warning（`ledger.jsonl: skipped N unparseable
  non-final line(s)`）——不會讓整個載入中斷。
- **同 process read-your-writes**：`recordProcessed` append 完之後直接更新
  記憶體內的 `Set<"sid|hash|ver">` 跟 `maxProcessedAt`，不用重讀檔案，所以
  同一個 process 內「寫完馬上查」保證看得到。
- **mtime 重載（跨 process 一致性，Task 5 修正）**：長壽命 process（例如
  mcp-server）可能在載入 ledger 之後，另一個獨立 process（夜間排程的
  distiller）才 append 新記錄進同一個 `ledger.jsonl`。`ensureLoaded()`
  每次呼叫都先 `statSync` 檔案的 mtime（一次 stat 很便宜），只有 mtime 跟
  上次載入時記錄的 `lastMtimeMs` 不同才真的重新 parse 整份檔案——包含
  「檔案本來就不存在」這個狀態（`null === null` 也算沒變，跳過重讀）。
  `recordProcessed` 寫完之後會把 `lastMtimeMs` 更新成自己剛寫完的 mtime，
  讓寫入者自己下一次呼叫不用白白重讀一次它自己已經知道的狀態。淨效果：
  一個長壽命的 `FileScanIndex` 實例在下一次 `isProcessed()`/`stats()` 呼
  叫時，會自動看到「別的 process 剛剛寫進去」的新記錄，不需要重新建構整
  個 index。
- **兩模式不共用、不 migrate**：sqlite 模式繼續只用 sqlite 表，filescan
  模式只用 `ledger.jsonl`，兩者之間沒有 dual-write，也沒有切換模式時的
  資料搬遷——換模式最壞情況就是每個 transcript 多跑一次抽取，RECONCILE
  的既有去重邏輯會吸收掉重複結果。

### 警語格式

固定印到 **stderr**（絕對不能印到 stdout——mcp-server 的 stdout 是 MCP
protocol channel），每個 process 每個進入點只印一次：

```
agent-memory: sqlite unavailable (<reason>) — markdown-scan mode: search is
O(n) without bm25 ranking, access stats disabled, ledger uses ledger.jsonl
```

`<reason>` 直接來自 `SqliteProbe.reason`（例如 `disabled by
AGENT_MEMORY_NO_SQLITE`，或探測失敗時原始 error 訊息的字串化）。

### `AGENT_MEMORY_NO_SQLITE` 環境變數

| 值 | 效果 |
|---|---|
| `"1"` | 強制走 filescan 模式，probe 完全不碰檔案系統，直接短路回傳 `{ ok: false }`——測試兩種模式的手段，也適用於「probe 會過但正式使用時已知不可靠」的環境 |
| 未設 / 其他值 | 正常跑 probe，結果決定模式 |

`cli.ts`/`mcp-server/main.ts`/`mcp-server/probe.ts`/`eval/run.ts` 都是把
`process.env` 整包傳給 `probeSqlite`，不是只挑這一個變數；`eval/run.ts`
額外開了 `EvalOptions.env` 讓測試可以注入自訂 env 覆蓋（見
`fallback.e2e.test.ts` 的 (e) 案例）。

## 回歸評測（`eval/`）

`bun run eval` 是一套**確定性**的回歸評測，回答兩個問題：換 prompt、換模型、
換 salience 門檻、換排序邏輯之後，抽取（extraction）還抽得出該抽的東西、
且雜訊 transcript 還是抽不出任何東西嗎？檢索（retrieval）還能替真實查詢
排出該排出的那筆 memory 嗎？完整設計見
`docs/superpowers/specs/2026-07-11-regression-eval-design.md`，手動驗證清單
見 `docs/superpowers/VERIFY-eval.md`。

### 兩套評測的角色

- **Extraction 套**（`eval/fixtures/*.md` + `eval/cases.json`）——對三份真實
  transcript 跑「真的」pipeline 前半段：`parseTranscript` →
  `buildExtractPrompt` → `LlmClient.complete`（走 `clientFromEnv()`，預設
  opencode-run，換模型只要設 `AGENT_MEMORY_LLM=vllm`）→
  `validateCandidates`。**不跑 RECONCILE/COMMIT**，也**絕對不碰**
  `~/.agent-memory`——這是 extraction 品質的迴歸網，也是換模型時的
  schema-fidelity 探測器：LLM 輸出 parse 失敗或某個候選驗證失敗（例如幻覺
  錨點），直接算這個 fixture 失敗，這正是換 vLLM backend 時最想抓到的訊號。
- **Retrieval 套**（`eval/retrieval/store/` + `eval/retrieval/queries.json`）
  ——用 checked-in 的 golden memory store 在 tmp 目錄建一個拋棄式
  `MemoryIndex`，對每個 query 呼叫真正的 `searchMemory()`，檢查
  `expect_id` 有沒有落在前 `within_top` 名內。完全不呼叫 LLM，毫秒級，用來
  守排序公式/FTS 邏輯的迴歸。

指令：`bun run eval`（兩套都跑）、`bun run eval --extraction-only`、
`bun run eval --retrieval-only`。Exit code `0` 全過、`1` 任何一項失敗
（CI 友善）。每次執行都會在 `eval/results.jsonl` append 一行
`{ ts, model: llm.describe(), extraction, retrieval, pass }`；這支檔案有
進 git，但**不是每次跑都要 commit**——只有代表一個有意義結果（baseline、或
一次刻意的模型/prompt 比較）才手動 commit，邊調 fixture 邊跑的雜訊行不用
留著。

### 確定性判分原則（為何不用 LLM judge）

`eval/match.ts` 的 matcher 是純函式：`candidate.type === rule.type`（有給
`type` 才檢查）且每個 keyword 都是 `title+trigger+lesson` 小寫後的子字串
才算命中，沒有任何一步呼叫 LLM。刻意不用 LLM 當裁判——LLM judge 本身也會
隨著要被測的那個模型/prompt 變動而漂移，等於用會動的尺量會動的東西，
迴歸訊號就失去意義。deterministic matcher 的代價是死板（同義詞、換句話說
都抓不到），所以 fixture 作者必須挑 transcript 裡**確實出現過的字面**當
keyword，而不是憑印象改寫。

### Fixture 增補流程

1. 把一份真實（或用 `serializeEntry` 手刻、shape 對齊的）transcript 丟進
   `eval/fixtures/<name>.md`；入庫前先跑 `scanSecrets`
   （`distiller/extract.ts`）確認乾淨，不含 credential、不含外部人名。
2. 在 `eval/cases.json` 加一個 case。`expect` 的 keyword 要挑 transcript
   裡**最強、最字面**的內容訊號（transcript 自己用過的詞，不是換句話說），
   這樣才能跨模型穩定。**能不指定 `type` 就不要指定**——同一段內容合理
   落在兩種分類之間（例如「團隊政策」到底算 `decision` 還是
   `convention`）時，就算模型固定不變，光是取樣變異就會讓帶 `type` 的
   rule 偶爾失敗（這個 repo 的 baseline 跑的過程中真的踩到兩次：一次是
   `synthesis` pitfall 被模型隨機分類成 `root_cause`，一次是 `useful skew`
   decision 被分類成 `convention`；拿掉 `type` 限制、只留 keyword 就穩定
   了，斷言的本意沒有變弱）。
3. 雜訊（zero-extraction）fixture 用 `"expect": [], "max_total": 0`。
4. **空 keywords 陷阱**：`{ "keywords": [] }` 不是「什麼都不比對」，而是
   「什麼都比對得上」——`rule.keywords.every(...)` 對空陣列永遠回傳
   `true`，所以空 keywords 的 `expect` rule 只要有任何候選存在
   （型別符合的話）就會判定命中，等於斷言形同虛設；空 keywords 的
   `forbid` rule 則會把每一個候選都標成禁區。寫 case 時 keyword 陣列**一定
   要**至少放一個真的字。
5. Retrieval 對應：真實或手刻的 entry 放進
   `eval/retrieval/store/memories/<project>/`，query 加進
   `eval/retrieval/queries.json`。
6. Commit 前用 `bun run eval --extraction-only` 多跑幾次——opencode-run
   這個 dev fallback backend 的 schema 穩定度明顯不如開了 guided decoding
   的 vLLM（見下方換模型 SOP 執行紀錄），一個新 case 沒有連跑兩三次觀察過
   就 commit，很容易誤把「這次剛好抽到的樣本」當成穩定行為。

### 換模型驗收 SOP

換 distiller 的 LLM backend（或換 prompt、換 salience 門檻）時，這套
harness就是設計來擋這件事的：

```bash
# eval/results.jsonl 裡已經有 opencode-run backend 的 baseline 那一行
AGENT_MEMORY_LLM=vllm AGENT_MEMORY_VLLM_URL=http://... AGENT_MEMORY_VLLM_MODEL=... \
  bun run eval --extraction-only
```

**跑兩次確認穩定，再 diff `results.jsonl`**——LLM 輸出本質上是非決定性的，
單跑一次綠燈不代表穩定、單跑一次紅燈也不代表真的退步了，只有「重複出現的
差異」才算數。兩次都綠、且 `extraction.{fixturesPass, expectationsMet,
errors}` 跟 baseline 那行打平或更好，才把新的那行 `results.jsonl` commit
進去；`model` 欄位（`llm.describe()`）換了值本身就是最直接的 diff 錨點。

**實測補充（本機 baseline 執行紀錄）**：跑 baseline 的過程中觀察到
opencode-run backend 明顯的樣本間變異——同一支 fixture 連續呼叫，偶爾整批
候選會因為證據錨點被截斷（例如把 `msg_f4b912944001ihETUskBWfmYCm` 回傳成
截斷的 `msg_f4b912944001`）或缺必填欄位（例如漏掉 `trigger`）而全部驗證
失敗，這正是 spec 設計成「parse/validate 失敗算失敗」要抓的 schema-fidelity
訊號，不是 cases.json 該調的東西；上一節提到的兩個 `type` 限制鬆綁才是
cases.json 層級能修的部分。細節與跑幾次才穩定見
`docs/superpowers/VERIFY-eval.md`。

## 文件對照表

| 主題 | 路徑 |
|---|---|
| 完整架構規格（三元件、資料流、格式契約） | `docs/superpowers/specs/2026-07-10-agent-memory-design.md` |
| collector 的 TDD 實作計畫（plan 1 of 3） | `docs/superpowers/plans/2026-07-10-collector.md` |
| distiller 的 TDD 實作計畫（plan 2 of 3） | `docs/superpowers/plans/2026-07-10-distiller.md` |
| 審查流程 + CJK trigram 搜尋設計規格 | `docs/superpowers/specs/2026-07-10-review-loop-cjk-design.md` |
| 審查流程 + CJK trigram 搜尋的 TDD 實作計畫 | `docs/superpowers/plans/2026-07-10-review-loop-cjk.md` |
| 端到端可行性驗證（Spike A：匯出→抽取→驗證） | `docs/superpowers/SPIKE.md` |
| 記憶系統技術調研 | `docs/research/2026-07-10-memory-systems-landscape.md` |
| 蒸餾 pipeline 模式調研 | `docs/research/2026-07-10-distillation-pipeline-patterns.md` |
| 回歸評測設計規格 | `docs/superpowers/specs/2026-07-11-regression-eval-design.md` |
| 回歸評測的 TDD 實作計畫（plan 3 of 3） | `docs/superpowers/plans/2026-07-11-regression-eval.md` |
| SQLite 可選模式設計規格 | `docs/superpowers/specs/2026-07-11-sqlite-optional-design.md` |
| SQLite 可選模式的 TDD 實作計畫 | `docs/superpowers/plans/2026-07-11-sqlite-optional.md` |
| 抽取品質包（triage/自洽/judge）設計規格 | `docs/superpowers/specs/2026-07-11-quality-pack-design.md` |
| 抽取品質包的 TDD 實作計畫 | `docs/superpowers/plans/2026-07-11-quality-pack.md` |
| Reflect（跨 session 整併）設計規格 | `docs/superpowers/specs/2026-07-11-reflect-design.md` |
| Reflect 的 TDD 實作計畫 | `docs/superpowers/plans/2026-07-11-reflect.md` |
| collector 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY.md` |
| distiller 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY-distiller.md` |
| 審查流程 + CJK 搜尋手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY-review-cjk.md` |
| mcp-server 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY-mcp.md` |
| 回歸評測手動驗證清單 + 本機 baseline 執行紀錄 | `docs/superpowers/VERIFY-eval.md` |
| SQLite 可選模式手動驗證清單 + 本機真實 store 執行紀錄 | `docs/superpowers/VERIFY-sqlite-optional.md` |
| 抽取品質包手動驗證清單 + 本機真實 transcript 執行紀錄 | `docs/superpowers/VERIFY-quality-pack.md` |
| Reflect 手動驗證清單 + 本機真實 store 執行紀錄 | `docs/superpowers/VERIFY-reflect.md` |
| Plan 1/2/3 逐 task 進度與遺留項目 ledger | `.superpowers/sdd/progress.md` |

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
[distiller]  INGEST → TRIAGE → EXTRACT → VALIDATE → RECONCILE → COMMIT → PUBLISH   ← 尚未實作（phase 2）
   │
   ▼
~/.agent-memory/store/memories/**.md, index.db (FTS5)
   │
   ▼
[mcp-server]  search_memory / get_memory / list_domains / memory_stats   ← 尚未實作（phase 2）
```

本 repo 目前**只出貨 `collector/`**。`distiller/`、`mcp-server/` 是空目錄，等
之後的 plan 才會填。`AGENT_MEMORY_HOME`（預設 `~/.agent-memory`）是所有輸出的
根目錄，設計上 `store/` 之後會整包進 git，跟現有的 markdown LLM-wiki 系統共用
生態。

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
   跟 collector 本身無關（collector 不呼叫 `opencode run`），但因為
   distiller 的 `OpencodeRunClient`（phase 2）會用到同一個 CLI，先記在
   這裡，之後寫 distiller 時不要重踩。

## 文件對照表

| 主題 | 路徑 |
|---|---|
| 完整架構規格（三元件、資料流、格式契約） | `docs/superpowers/specs/2026-07-10-agent-memory-design.md` |
| collector 的 TDD 實作計畫（plan 1 of 3） | `docs/superpowers/plans/2026-07-10-collector.md` |
| 端到端可行性驗證（Spike A：匯出→抽取→驗證） | `docs/superpowers/SPIKE.md` |
| 記憶系統技術調研 | `docs/research/2026-07-10-memory-systems-landscape.md` |
| 蒸餾 pipeline 模式調研 | `docs/research/2026-07-10-distillation-pipeline-patterns.md` |
| 手動驗證清單（headless + interactive 項目） | `docs/superpowers/VERIFY.md` |

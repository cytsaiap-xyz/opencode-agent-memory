# Agent 記憶系統：調查、選型與自建方案總報告

**日期：** 2026-07-11
**範圍：** 2026 年中 agent 記憶系統全景調查（40+ 來源）、選型決策、自建系統 opencode-agent-memory 的實作與實測結果
**原始資料：** `2026-07-10-memory-systems-landscape.md`（系統全景，英文）、`2026-07-10-distillation-pipeline-patterns.md`（蒸餾管線模式，英文）

---

## 1. 需求與約束（決策的量尺）

| 約束 | 內容 |
|---|---|
| 部署 | 完全 on-prem（IC 設計公司，資料不出廠），LLM 為自架 vLLM（OpenAI-compatible） |
| 目標知識 | 工程經驗：開發決策、debug 根因、IC design know-how、techfile/DRM/DRC 處理經驗——**不是**個人助理型事實 |
| 既有生態 | 以 markdown LLM-wiki 為基底的知識管理系統；記憶最終要與 wiki 整合 |
| 技術棧 | TypeScript + Bun / Python + uv |
| 型態 | 批次蒸餾可接受（不需即時）；來源是 opencode 對話紀錄 |
| 治理 | 工程正確性至上——錯的記憶比沒有記憶更危險（實證研究：agent 會強烈跟隨檢索到的記憶，包括錯的） |

---

## 2. Survey 了哪些作法、各自怎麼運作

### 2.1 商用/OSS 記憶平台

**Mem0**（~60.5k★，Apache-2.0，募資 $24M）
- **怎麼做**：兩階段管線——(1) LLM 從對話抽取原子化事實；(2) 每條事實 embedding 後跟既有記憶比對，第二個 LLM call 決定 ADD / UPDATE / DELETE / NOOP。向量庫（Qdrant 等 20+ 後端）儲存。曾有 graph 變體（Mem0ᵍ）。
- **優點**：最成熟的「抽取→調和」迴圈（本報告自建系統的 RECONCILE 階段直接借用此設計）；TS/Python 雙 SDK；vLLM 支援一流。
- **缺點**：**2026/04 的 OSS v3 把 graph memory 與 UPDATE/DELETE 整合從開源版移除、改為付費版限定**——開源版只剩 ADD-only，工程知識最需要的「新修法取代舊 workaround」正好做不到。抽取形狀是個人助理型（「使用者喜歡 X」），把工程知識的「為什麼」推理鏈打碎丟掉。官方 benchmark 與 Zep 互噴、雙方都能把對方重現到低 10-25 分，可信度存疑。

**Letta（原 MemGPT）**（23.7k★，Apache-2.0）
- **怎麼做**（classic）：self-editing memory blocks（常駐 context 的人格/事實區塊）+ recall memory（全歷史）+ archival memory（pgvector 段落）+ sleep-time compute（背景 agent 在閒置時整理記憶）。2026 年新旗艦 **MemFS**：記憶改為 **git-backed markdown 檔案庫**，「dream」子 agent 批次回顧 session、把教訓寫進記憶檔。
- **優點**：sleep-time compute（線上用快模型、離線整理用強模型）與 MemFS（markdown + git + 排程整理）是全場最好的兩個架構想法——自建系統兩者都借了。
- **缺點**：**平台劇烈變動**——自架 server 在 2026 年被官方宣告不再維護，2025 年押注的 API 面在 2026 年被棄用；MemFS 官方自承對 open-weight 模型表現差；記憶要跟 Letta 的 harness 綁定。

**Zep / Graphiti**（Graphiti 28.6k★，Apache-2.0）
- **怎麼做**：ingest episodes → LLM 抽取 entity + relation 事實、對圖去重、解衝突；**bi-temporal 模型**——每條事實帶有效期間 + 錄入時間，被反駁的事實「標註失效、永不刪除」，支援時間點查詢（「tape-out X 當時我們相信什麼」）。檢索是 semantic + BM25 + 圖遍歷混合，查詢時零 LLM。可自訂 Pydantic ontology。
- **優點**：bi-temporal「失效不刪除」模型是全場最適合稽核導向環境的設計（自建系統的 supersession 語義借自於此）；查詢便宜；vLLM 支援一流。
- **缺點**：**Zep 開源版 2025/04 凍結**，平台版無自助 on-prem；Graphiti 需要養 Neo4j/FalkorDB；Python-only 核心；抽取品質完全取決於本地模型的 structured output 保真度（社群回報中小模型常吐壞 schema）；多段落的 debug 敘事會被打碎成原子事實，敘事脈絡（工程知識的核心）流失。

**LangMem**（LangChain，MIT，1.5k★）
- **怎麼做**：SDK 原語而非伺服器——hot path 給 agent 記憶工具；背景 `ReflectionExecutor`（debounce、閒置後處理）驅動管理型 LLM 對 **typed Pydantic schema** 做 insert/update/delete。儲存走 Postgres+pgvector。
- **優點**：**typed schema 抽取**是殺手級想法（定義 `DebuggingLesson{symptom, root_cause, fix}` 這種型別讓抽取受 schema 控制）——自建系統的六型分類 + JSON Schema 驗證直接承襲此路線。
- **缺點**：Python-only、無 MCP、半休眠狀態（最後 release 2025/10、pre-1.0）、無圖、綁 LangGraph 生態。

**Cognee**（27.4k★，Apache-2.0，2026/06 出 1.0）
- **怎麼做**：ECL 管線——Add → Cognify（分類→切塊→LLM 三元組抽取→embedding）→ graph + vector + relational 三層混合儲存；Memify 批次整理（剪枝、按使用率重加權、衍生新事實）；15 種檢索模式（多跳 CoT、時間性、NL→Cypher）；OWL ontology 驗證抽取實體。
- **優點**：圖關係是工程知識的自然形狀（`Bug —caused_by→ RaceCondition —fixed_by→ CommitX`）；官方 TS SDK；單一 Postgres 部署模式；vLLM 明確支援。
- **缺點**：1.0 剛出數週、API 變動風險高；**LLM/Embedding 環境變數漏設其中一個會靜默 fallback 到 api.openai.com**（對 air-gapped 部署是致命陷阱）；Cognify 極耗 LLM call；emergent schema 噪音需要 ontology 從第一天就管住。

**Hindsight（Vectorize）**（18.2k★，MIT）
- **怎麼做**：Retain（抽取 entity/relation/時序，sparse+dense 向量）/ Recall（四路並行檢索 + RRF 融合 + rerank）/ Reflect（離線批次形成「心智模型」）。全部裝在 PostgreSQL，一鍵 Docker。
- **優點**：新秀中工程最扎實的完整引擎；LongMemEval SOTA 有第三方獨立重現（此領域罕見）；MIT。
- **缺點**：記憶住在 Postgres 不是 markdown——與 wiki 生態的橋接全是自己的工；買整套引擎意味著接受它的抽取形狀。

**其他新秀速覽**：Memori（記憶=可稽核的 SQL 列，無向量庫，形狀太扁平）；Supermemory（TS 棧加分，但 air-gapped 自架被 enterprise 銷售把關）；MemOS（MemCube 含 KV-cache/LoRA 記憶，研究方向獨特但運維沉重）；Memobase（人物側寫型，領域形狀完全不合）；Beads（git/Dolt 任務圖，解的是 WIP 狀態不是蒸餾知識——互補品）；mem-agent（4B 小模型 RL 訓練成 markdown 記憶管家——證明「小模型當記憶園丁」可行）。

### 2.2 學術方案（模式捐贈者，非可部署品）

- **Generative Agents**（Stanford 2023）：記憶流 + 三因子檢索（recency × importance × relevance）+ **reflection trees**（週期性批次歸納出高階洞見、引用證據記憶）。幾乎被所有後繼系統借用。→ 自建系統借：兩層蒸餾概念（per-session 抽取 → 未來的跨 session REFLECT）、證據引用。
- **MemoryBank**：階層式摘要 + **Ebbinghaus 遺忘曲線**（召回強化、閒置衰減）。→ 借：只對 `volatile` 事實衰減的原則（「很少被查的根因分析依然是真的」——時間衰減對工程事實是錯的）。
- **A-MEM**（NeurIPS 2025）：Zettelkasten 式原子筆記 + LLM 決定連結 + **記憶演化**（新筆記觸發舊筆記改寫）。→ 借：wiki 式互連願景；但工程真相「改寫」必須留稽核軌跡——自建系統改為 append-only notes + supersession。
- **ExpeL**：成功/失敗軌跡對比抽取 + 洞見清單投票（ADD/UPVOTE/DOWNVOTE）。→ 借：證據數驅動的 confidence；「失敗後修正的對比」是最高訊號抽取目標（寫進了抽取 prompt）。
- **MIRIX**：六型記憶分類學（Core/Episodic/Semantic/Procedural/Resource/Vault）。→ 借：episodic/semantic/procedural 三層 memory_class。

### 2.3 檔案為本模式（最後的贏家）

- **Claude Code auto-memory**：MEMORY.md 索引（≤200 行自動載入）+ 一事一檔 + agentic 檔案讀取，**明確棄用 RAG/向量庫**（Boris Cherny：「agentic search 通常更好——更簡單，沒有安全、隱私、過期、可靠性問題」）。
- **關鍵 benchmark**：Letta 自己的實驗顯示 **grep-over-files agent 拿 74.0%（LoCoMo），打贏 Mem0 graph 變體的 68.5%**。工程內容（signal 名、error string、tool flag）是詞彙精確匹配最強的領域。
- **basic-memory**（AGPL）：markdown 為真相源 + SQLite FTS + 本地 embedding 混合索引 + MCP——現成品中最接近需求形狀，但 AGPL、單使用者導向、抽取管線要自建。
- **2026 年的業界收斂**：Claude Code、Anthropic API memory tool、Letta MemFS、MemU——四個獨立陣營全部落在「**純檔案 + 索引 + 詞彙搜尋**」。

---

## 3. 為何選擇自行開發

四個決定性理由，按權重排序：

**理由一：現成平台的 OSS 趨勢在劣化，而這是一個要活很多年的 on-prem 系統。**
2025-2026 一年內：Mem0 把工程記憶最需要的功能（UPDATE/DELETE 整合、graph）從開源版抽走；Zep CE 凍結；Letta 自架 server 棄維護。押注任何一家，等於把系統核心綁在會抽走功能或棄坑的供應商上——對「資料不出廠、要長期自主維運」的環境是不可接受的尾部風險。

**理由二：事實形狀不合。**
現成平台的抽取管線為個人助理最佳化（「使用者住台北」「偏好深色模式」）——原子化、無脈絡。工程知識的價值在**決策理由、失敗→修正的對比、觸發條件**（「當 X 時做 Y 因為 Z」）。要把現成管線改到這個形狀，客製的部分（prompt、schema、驗證、治理）恰恰就是系統的核心——外殼反而是最容易寫的部分。

**理由三：與既有 LLM-wiki 生態的整合成本。**
需求明確要求記憶最終匯入 markdown wiki。檔案為本方案的整合成本是**零**（同一種格式、同一個 git 生態）；DB-resident 方案（Graphiti/Cognee/Hindsight）則需要永久維護一條「DB→markdown」的橋，且 wiki 側的人工編輯無法回流。

**理由四：業界證據站在簡單這邊。**
四個獨立陣營收斂到檔案為本 + 詞彙搜尋；Letta 的 benchmark 顯示 grep 打贏向量圖譜；團隊 wiki 規模（數千頁以下）遠低於向量檢索開始佔優的交叉點。在這個規模，重型基建（Neo4j/Qdrant/Postgres）買到的是維運負擔，不是檢索品質。

**「借用而非採用」清單**——自建不等於從零發明，每個關鍵設計都有出處：

| 自建系統的設計 | 借自 |
|---|---|
| EXTRACT→VALIDATE→RECONCILE（ADD/UPDATE/SUPERSEDE/NOOP） | Mem0 兩階段迴圈 |
| 失效不刪除的 supersession | Zep/Graphiti bi-temporal |
| 六型 typed schema + 逐欄位驗證 | LangMem typed Pydantic + 自家 house rule |
| 離線批次用強模型蒸餾 | Letta sleep-time compute |
| markdown 真相源 + 可重建索引 | Claude Code / Letta MemFS |
| 證據引用 + 錨點驗證 | Generative Agents citations |
| 證據數驅動 confidence、對比抽取 | ExpeL |
| trigger 與 lesson 分離、專案隔離+升級 | ECC instinct 系統 |
| volatile-only 衰減原則 | MemoryBank（反面教訓） |

---

## 4. 自建系統：opencode-agent-memory

### 4.1 架構

```
opencode.db（唯讀）→ [collector plugin] session.idle 觸發
  → transcripts/<project>/<session>.md（人可讀、{#msg_id} 證據錨點、content_hash 冪等）
  → [distiller 批次] INGEST → TRIAGE（<400字元免LLM）→ EXTRACT（六型+salience≥6）
      → VALIDATE（幻覺錨點拒收、機密掃描→quarantine、逐欄位schema）
      → RECONCILE（Mem0迴圈；decision/convention 的任何變動攔進人審）
      → COMMIT（ledger 冪等）→ PUBLISH（INDEX.md）
  → store/memories/<project>/<id>.md（一記憶一檔，YAML frontmatter）
      + index.db（SQLite FTS5 trigram，可隨時 reindex 重建）
  → [mcp-server] search_memory / get_memory / list_domains / memory_stats
```

配套：`distill review/approve/reject` 人審閉環（human_approved 才有 confidence +0.2）、`bun run eval` 回歸評測（換模型的保險絲）、一鍵部署 `setup.sh`、cron 夜跑 wrapper。158 tests。

### 4.2 實測證據（不是宣稱，是這台機器上跑出來的）

| 驗證 | 結果 |
|---|---|
| 閒聊對抗測試 | 短閒聊被 TRIAGE 擋（零 LLM 成本）；灌長的閒聊 LLM 讀完回 `[]`——**零噪音入庫** |
| IC design PPA 對話 | 三輪時序收斂討論 → 6 條記憶、六型分類全對；user correction（useful skew 禁令）被正確抽為 decision |
| Agent 自我進化閉環 | 全新 agent 被問「該用 useful skew 嗎」→ 查記憶 → 引用 `mem_8cd55e` 回答「本 flow 禁用」並給出上次實戰成功的替代流程 |
| 治理演練 | 偽造「解禁」session → 兩條 SUPERSEDE 提案全被攔進人審 → reject 後禁令原封不動 |
| 幻覺防線 | 真實 run 中 LLM 捏造的錨點被 VALIDATE 拒收（有 log 為證） |
| 回歸評測 baseline | extraction 3/3 fixtures、retrieval 4/4（含 CJK 查詢）、連續兩輪穩定 |

### 4.3 誠實的弱點清單

- **單機、單使用者**：團隊共享要靠 store 進 git 同步，merge 策略未定義。
- **無向量/語意檢索**：同義詞改寫的查詢（「時脈偏斜」查不到「useful skew」）會失配；規模長大後可能需要 hybrid。
- **抽取品質綁定模型校準**：salience 是 LLM 判斷，換模型會漂移——這正是回歸評測集存在的原因，但評測只能偵測、不能消除。
- **CJK 檢索已解但有殘餘**：混合查詢中 <3 字的 token 被忽略；記憶內容目前是英文，中文查詢靠 trigram 對照中文內容才完整。
- **REFLECT 未實作**：跨 session 的高階歸納、near-dup 合併、global 升級自動化都還是 backlog。
- **wiki 整合未完成**：記憶是 wiki-ready 格式但還沒有自動匯入管線（memory-as-PR）——原始願景的最後一哩。
- **開發後端不可靠**：`opencode run` 免費模型有間歇性 schema 保真度問題（評測有量到）；正式品質要等 vLLM 驗證。

---

## 5. 總比較表（含自建系統）

| 系統 | 儲存 | 抽取/整理 | 檢索 | on-prem+vLLM | 工程知識契合 | 治理/人審 | wiki 整合成本 | 長期風險 |
|---|---|---|---|---|---|---|---|---|
| **opencode-agent-memory（自建）** | markdown 一事一檔 + SQLite FTS5（可重建） | 六型 typed 抽取 + Mem0 迴圈 + 幻覺錨點驗證 + 機密隔離 | BM25 trigram + rank-position boost + CJK fallback | ✅ 原生（vLLM guided_json / opencode-run） | ✅✅ 為此而生（實測驗證） | ✅ 唯一有完整人審閉環（政策記憶變動必過人） | **零**（同格式同生態） | 自己維護（~4k 行 TS、158 tests、零 runtime 依賴核心） |
| Mem0 OSS v3 | 向量庫 | 抽取 ADD-only（UPDATE/DELETE 付費版限定） | hybrid | ✅ | ✗ 個助形狀、丟推理鏈 | ✗ | 高（DB→md 自建） | **高**（功能持續移入付費版） |
| Letta MemFS | markdown+git | dream agents | 記憶樹 + agentic 讀檔 | 局部（自承弱於 open-weight） | ◐ 模式極合、綁 harness | ✗ | 低 | **高**（2026 平台劇變前科） |
| Graphiti | Neo4j/FalkorDB 時間圖 | LLM 三元組 + bi-temporal 失效 | hybrid+圖遍歷 | ✅ | ◐ 稽核強、敘事碎裂 | ✗ | 高 | 中（活躍但 Python-only） |
| LangMem | Postgres+pgvector | typed schema 管理 | 語意 | ✅ | ◐ schema 想法好 | ✗ | 高 | 中（半休眠） |
| Cognee | graph+vector+SQL | Cognify/Memify | 15 模式 | ✅（有 fallback 陷阱） | ◐ 多跳強 | ✗ | 高 | 中（1.0 剛出） |
| Hindsight | PostgreSQL | Retain/Reflect | 四路+RRF | ✅ | ◐ 引擎優秀 | ✗ | 高 | 低-中 |
| basic-memory | markdown+SQLite | 無（手動/agentic） | FTS+本地 embedding | ✅ | ◐ 形狀近、無蒸餾管線 | ✗ | 低 | 中（AGPL、單人向） |
| 純 Claude Code 模式 | markdown | 模型自主、無批次管線 | grep/索引 | ✅ | ◐ 無自動蒸餾、無治理 | ✗ | 零 | 低 |

**一句話總結**：現成方案在「儲存與檢索」上各有強項，但沒有任何一家同時滿足（a）工程知識的事實形狀、（b）零成本 wiki 整合、（c）政策記憶的人審治理、（d）不受供應商 OSS 策略擺佈——自建系統的核心價值就是這四項的交集，而其餘部分全部借用已被驗證的設計。

---

## 6. 何時該重新評估現成方案（觸發條件）

1. **店規模破萬條**且詞彙檢索 recall 明顯不足 → 評估補 embedding hybrid（或掛 Graphiti 當可重建的衍生索引——store 格式從第一天就保留了這條路）。
2. **需要重度時間點查詢**（「tape-out X 當時的 methodology 是什麼」）→ Graphiti 衍生索引。
3. **多團隊並發寫入**成為常態 → 重新評估 DB-resident 方案或設計 git-based merge 協定。
4. Mem0/Letta 若逆轉 OSS 策略且事實形狀可深度客製 → 重新比價「維護成本 vs 遷移成本」。

---

## 附錄：文件對照

| 文件 | 內容 |
|---|---|
| `docs/research/2026-07-10-memory-systems-landscape.md` | 系統全景原始報告（英文，含全部來源連結） |
| `docs/research/2026-07-10-distillation-pipeline-patterns.md` | 蒸餾管線模式原始報告（英文） |
| `docs/superpowers/specs/` | 四份設計 spec（主系統、review+CJK、eval） |
| `docs/superpowers/VERIFY-*.md` | 全部實測驗證紀錄（含執行證據） |
| `eval/results.jsonl` | 回歸評測 baseline |

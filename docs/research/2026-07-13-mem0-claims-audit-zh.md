# Mem0 v3 宣稱查證報告（原始碼稽核）

**日期：** 2026-07-13
**動機：** 原調查報告（`2026-07-10-memory-systems-landscape.md`）中關於 Mem0 v3 的宣稱影響了自建決策，應對一手來源（原始碼、PR、官方文件）查證，而非停留在二手轉述。
**查證方法：** 直接抓取 GitHub `mem0ai/mem0` main branch 原始碼逐行 grep、`gh pr view` 讀取 PR 內容、抓取 docs.mem0.ai 官方文件、查詢 PyPI/npm registry 版本時間線。
**結論先講：** 原宣稱**一半對、一半錯**——錯的那半已於本日以帶日期更正註記修入兩份原報告（commit `57a2690`）；且修正後的事實讓自建決策的理由**更強**，不是更弱。

---

## 1. 受審宣稱（原報告原文）

> 「Mem0 的 OSS v3（2026/04）把演算法改為單趟 ADD-only 抽取——UPDATE/DELETE
> 整合呼叫從開源版移除、改為付費平台限定；外部 graph store 支援也從 OSS 刪除
> （PR #4805）。」

---

## 2. 逐項裁決

| # | 子宣稱 | 判定 | 一手證據 |
|---|---|---|---|
| 1 | OSS 的 `add()` 管線改為單趟 ADD-only | ✅ **TRUE** | `mem0/memory/main.py`（main branch）的 `_add_to_vector_store()` 是「V3 PHASED BATCH PIPELINE」：Phase 2 只有一個 LLM call（`ADDITIVE_EXTRACTION_PROMPT`），抽出的事實直接 insert，**沒有**第二個 LLM call 對既有記憶做 ADD/UPDATE/DELETE/NOOP 決策。舊的 `DEFAULT_UPDATE_MEMORY_PROMPT` 仍在 `configs/prompts.py` 但已是死碼（GitHub code search 證實除定義與測試外零呼叫點）。PR #4805 自己的 breaking-changes 表：「add() only returns "ADD" events (no "UPDATE"/"DELETE")」 |
| 2 | 自動整合「改為付費平台限定」 | ❌ **FALSE** | 官方 Platform「Add Memories」API 文件：*"The endpoint uses single-pass ADD-only extraction: one LLM call, no UPDATE/DELETE… Memories accumulate over time; nothing is overwritten."* 官方 blog：*"The new algorithm is available today on both the Mem0 platform and the open-source SDK."* ——自動整合是**全產品線退役**，付費平台同樣沒有保留 |
| 3 | （隱含）OSS 再無 UPDATE/DELETE 路徑 | ❌ **過度延伸** | 手動 CRUD 完好存在：`main.py` line 1773 `def update(self, memory_id, …)`、line 1825 `def delete(self, memory_id)`（AsyncMemory 亦同，line 3404/3457）。被移除的是 add() 管線內的**自動**調和決策，不是手動 API |
| 4 | Python 與 TS SDK 行為一致 | ✅ **TRUE** | `mem0-ts/src/oss/src/memory/index.ts`：同樣 `ADDITIVE_EXTRACTION_PROMPT` 驅動的單趟 add()（line 869）、手動 update()/delete() 保留（line 1633/1681）；graph_memory.ts 在同一個 PR 刪除 |
| 5 | PR #4805 存在且刪除了 OSS graph 支援 | ✅ **TRUE 且原報告低估** | PR 真實存在（*"feat(oss): port v3 pipeline…"*，2026-04-14 merge，99 檔 +10,200/−17,228）。刪除清單不只 Neo4j/Memgraph/Kuzu——**Apache AGE 與 AWS Neptune 後端也一併刪除**（graph_memory.py −744、kuzu_memory.py −732、memgraph_memory.py −708、apache_age_memory.py −595、neptune/* −1501）。取而代之的是內建 spaCy entity extraction（僅作排序加成，非可遍歷圖） |
| 6 | 「OSS v3、2026 年 4 月」時間線 | ✅ TRUE（版號註記） | PyPI `mem0ai`：1.0.11（04-06）→ 2.0.0（04-16）→ 現行 2.0.11；npm `mem0ai`：3.0.0-beta.1（04-14，PR merge 當日）→ 3.0.0（04-16）→ 現行 3.0.13。「v3」是**管線世代名**（PR 標題、遷移文件 slug `oss-v2-to-v3`），非統一套件版號——Python 套件實際升的是 2.0.0 |

---

## 3. 錯在哪裡、為什麼會錯

原報告把「自動整合從 OSS 消失」與「付費平台仍保有」兩件事連在一起推論成
「移入付費牆」——這是**趨勢敘事（open-core 劣化）套用過頭**：Zep 與 Supermemory
確實走了「功能收進商業版」的路，研究彙整時把 Mem0 錯誤地歸入同一模式。
一手來源顯示 Mem0 的實際動機不同：官方把 v3 定調為「token 效率演算法」
（一個 LLM call 取代兩個），是**產品方向改變**，不是商業牆。

教訓（已符合既有 house rule 的精神）：**影響決策的關鍵宣稱要在決策前對一手
來源查證**；查證成本（本次約 20 分鐘的原始碼稽核）遠低於錯誤敘事的風險。

---

## 4. 對自建決策的影響：結論不變、理由更強

| 面向 | 修正前的理解 | 修正後的事實 | 對決策的影響 |
|---|---|---|---|
| Reconcile 迴圈 | 好功能被鎖進付費牆（付錢可得） | **整個 Mem0 產品線都沒有了**——論文成名的兩階段 ADD/UPDATE/DELETE/NOOP 迴圈，OSS 和付費版都買不到 | 更強：自建的 RECONCILE（ADD/UPDATE/SUPERSEDE/NOOP + 政策人審）是這個需求目前唯一的實作 |
| 「新修法取代舊 workaround」 | OSS 做不到、平台可以 | **誰都做不到**（Mem0 生態內），記憶只會無限累積、過時事實永不失效 | 更強：工程知識的時效正確性需求 Mem0 完全放棄了 |
| 手動 CRUD | （原報告未細分） | 手動 update/delete 存在——但「手動逐條維護記憶庫」對批次蒸餾場景不可行 | 中性：不改變結論 |
| Graph | 從 OSS 移除 | 移除範圍更大（5 種後端全刪） | 略強 |
| 供應商風險敘事 | 「功能移入付費版」 | 「產品方向劇變、招牌能力直接砍掉」 | 等價或更強：無論哪種敘事，押注它的 API 面都是尾部風險 |

---

## 5. 已執行的修正（audit trail）

- `2026-07-10-memory-systems-landscape.md`：Executive Summary 第 2 點、比較表 Mem0 列、§2.1 關鍵變更段（加入帶日期更正註記）、§2.1 Fit 結論措辭。
- `2026-07-11-memory-systems-final-report-zh.md`：§2.1 Mem0 缺點段、§3 理由一、§5 比較表 Mem0 列。
- 修正原則：**帶日期的更正註記、不無痕改寫**——錯誤的原文脈絡可從 git 歷史與註記還原。
- Commit：`57a2690 docs(research): correct mem0 v3 claims after primary-source audit`。

---

## 6. 一手來源清單

- [PR #4805 — feat(oss): port v3 pipeline](https://github.com/mem0ai/mem0/pull/4805)（merge 2026-04-14）
- [mem0/memory/main.py（main branch）](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py) — Python OSS 管線與手動 CRUD
- [mem0-ts/src/oss/src/memory/index.ts](https://github.com/mem0ai/mem0/blob/main/mem0-ts/src/oss/src/memory/index.ts) — TS OSS 對應
- [遷移文件 OSS v2→v3](https://docs.mem0.ai/migration/oss-v2-to-v3)
- [官方 blog：Token-Efficient Memory Algorithm](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)（「available today on both the Mem0 platform and the open-source SDK」）
- [Platform Add Memories API 文件](https://docs.mem0.ai/api-reference/memory/add-memories)（平台端 ADD-only 的直接證據）
- [Update Memory 概念文件](https://docs.mem0.ai/core-concepts/memory-operations/update)（手動 API 兩邊都有）
- [PyPI mem0ai](https://pypi.org/project/mem0ai/) / [npm mem0ai](https://www.npmjs.com/package/mem0ai)（版本時間線）

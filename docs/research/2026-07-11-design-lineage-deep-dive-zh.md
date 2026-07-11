# 設計血統深度解析：每個借用的出處、優點與達成效果

**日期：** 2026-07-11
**定位：** 總報告（`2026-07-11-memory-systems-final-report-zh.md`）§3「借用而非採用」對照表的逐項深度版
**原則：** 自建不等於從零發明。系統的競爭力來自「把九個已被驗證的設計，組合在現成方案沒有覆蓋的交集上」。本文逐項說明：原始設計是什麼、它好在哪、我們如何落地（含做了什麼取捨修改）、以及最終達成的效果——效果欄盡量引用本機實測數據，不是推測。

---

## 1. 兩階段「抽取→調和」迴圈 ← Mem0

**原始設計**：Mem0 論文（arXiv 2504.19413）的核心貢獻。第一階段 LLM 從對話抽出候選事實；第二階段對每條候選檢索最相似的既有記憶，再讓 LLM 用 tool-call 從 ADD / UPDATE / DELETE / NOOP 中**恰好選一個**操作。

**好在哪**：解決記憶系統最根本的腐化問題——**「抽取永遠不准直接寫入儲存」**。沒有調和階段的系統跑幾千個 session 後必然充滿重複與自相矛盾的條目；調和階段讓每條新知識先跟舊知識「對質」，儲存才能長期保持一致。用 tool-call 強制單選（而非自由文字）則讓 LLM 的決策可解析、可驗證、可統計。

**我們的落地**（`distiller/reconcile.ts`）：保留骨架，做了三個修改——
1. **DELETE 換成 SUPERSEDE**（見 §2，永不刪除）；
2. LLM 只能從「實際檢索到的鄰居」中指名 target（`parseReconcileOp` 驗證 target_id ∈ 鄰居集合）——LLM 無法憑空指涉不存在的記憶；
3. 零鄰居時直接 ADD、**跳過 LLM call**（省成本）。

**達成效果**：同一教訓從第二個 session 出現時走 UPDATE 而非重複 ADD——PPA 實測中第二次出現的候選正確合併進既有條目、evidence 從 1 筆變 2 筆、confidence 0.5→0.65。調和同時是**冪等後盾**：重跑同一批 transcript 時重複抽取的內容全部落在 NOOP/UPDATE，不會複製貼上整個店。

---

## 2. 失效不刪除（supersession）← Zep / Graphiti bi-temporal

**原始設計**：Graphiti 的每條事實邊帶「有效期間 + 錄入時間」雙時間軸；被新事實反駁的舊事實**標註失效日期、永不刪除**，因此支援時間點查詢（「tape-out X 當時我們相信什麼」）。

**好在哪**：工程環境（尤其 IC 設計這種稽核導向的行業）的知識不是「對/錯」而是「何時對」。刪除等於銷毀歷史；標註失效則同時保留「當時為什麼這樣做」的脈絡與「後來為什麼改」的軌跡。這跟 git 的世界觀完全一致——append-mostly、用 tombstone 不用 rm。

**我們的落地**（`distiller/store.ts` + `reconcile.ts`）：不需要完整雙時間軸的查詢能力（那是 Graphiti 要養 Neo4j 的理由），簡化為三個欄位——`status: superseded`、`superseded_by: <新條目id>`、外加一條帶日期的 note 記錄取代原因。舊檔案原地保留、reindex 永遠掃得到。`reject` 同理：`status: archived` + 理由 note，檔案不動。

**達成效果**：治理演練中被 reject 的兩條「解禁提案」如今以 `archived` 狀態躺在店裡，帶著完整的提案內容與駁回理由——半年後若有人再提解禁，歷史脈絡一查就有。全系統沒有任何一條程式路徑會 unlink 一個記憶檔（唯一的 unlink 是 approve 時把檔案從 quarantine 搬進 memories/，內容無損）。

---

## 3. Typed schema 抽取 + 逐欄位驗證 ← LangMem（+ 自家 house rule）

**原始設計**：LangMem 讓記憶管理 LLM 對 **typed Pydantic schema** 做增刪改——`DebuggingLesson{symptom, root_cause, fix}` 這種型別讓「抽什麼、長什麼樣」由 schema 控制，而不是由模型當天的心情控制。

**好在哪**：這是「個人助理型記憶」與「工程知識型記憶」的分水嶺。自由文字抽取會產出「使用者在調時序」這種無用摘要；typed schema 強迫模型把知識折成**可檢索、可比較、可治理**的形狀（type、trigger、lesson、evidence 各就各位）。schema 同時是與本地模型的契約——vLLM 的 guided decoding 可以在 decoder 層面強制執行它。

**我們的落地**（`distiller/extract.ts`）：六型分類（decision / root_cause / pitfall / know_how / convention / workflow）+ `EXTRACT_SCHEMA`（JSON Schema，餵給 vLLM `json_schema` 模式）+ `validateCandidates()` 純程式逐欄位複驗（type 白名單、lesson ≤80 字、salience 數值、evidence 非空）。雙保險：guided decoding 管正式環境，程式驗證管一切環境（開發用的 opencode-run 後端沒有 guided decoding）。這也是自家 house rule「LLM 輸出進結構化資料前必須逐欄位驗證」（踩坑史第 2 條，修過 5+ 次的教訓）的直接體現。

**達成效果**：PPA 實測六型分類全數正確；回歸評測中 opencode-run 後端間歇性吐壞 schema 時，**壞輸出被完整攔截並計為 error**，一條都沒漏進店裡——驗證層量到了後端的不可靠，而不是被它污染。

---

## 4. 離線批次用強模型 ← Letta sleep-time compute

**原始設計**：Letta 把 agent 拆成兩隻——線上主 agent 服務即時流量（快、便宜的模型），**睡眠 agent** 在閒置時段用更強、更慢的模型整理記憶，且是記憶區塊的唯一寫入者。核心口號：把「raw context」轉成「learned context」。

**好在哪**：兩個洞見。其一，記憶整理沒有延遲壓力，所以**永遠應該用你最強的模型**——這是免費的品質升級。其二，「單一寫入者」紀律天然消除寫入競態：線上 agent 只讀、離線管線只寫，不需要鎖。

**我們的落地**：整個 distiller 就是那隻睡眠 agent——cron 夜跑（`scripts/run-distill.sh`）、TRIAGE 先用零成本啟發式把無料 session 篩掉（多數 session 抽不出東西，跳過它們才是成本節約的主力）、剩下的才進大模型。寫入面：只有 distiller 和人審指令寫 store；collector 只寫 spool；mcp-server 只寫 access 統計。

**達成效果**：全量夜跑實測 16 個 transcript 中 12 個 eligible、只有 8 個真正花了 LLM call（其餘被 ledger/TRIAGE 擋下）；LLM 預算全部集中在有料的內容上。架構上為「公司 vLLM 最強模型 + 更高推理設定」預留了插槽——換後端只是三個環境變數。

---

## 5. Markdown 真相源 + 可重建索引 ← Claude Code / Letta MemFS

**原始設計**：Claude Code 的 auto-memory（MEMORY.md 索引 + 一事一檔 + agentic 檔案讀取，明確棄用 RAG）與 Letta 2026 年轉向的 MemFS（記憶=git-backed markdown repo）。兩個獨立陣營收斂到同一形狀。

**好在哪**：四重優點——(a) **人可直接讀寫**：記憶不是 DB 裡的黑盒列，工程師用任何編輯器就能翻、能改、能 review；(b) **git 免費送版本控制**：diff、blame、merge、備份全部不用寫；(c) **索引可拋棄**：衍生資料（FTS index）壞了就重建，真相永遠在檔案裡——這消滅了一整類「索引與資料不一致」的維運事故；(d) 對我們特別關鍵：**與 LLM-wiki 是同一種物質**，整合是搬檔案不是寫橋接器。

**我們的落地**（`distiller/store.ts` + `ledger.ts`）：一記憶一檔（YAML frontmatter 機讀層 + 正文人讀層）、序列化/解析自己寫（零依賴、嚴格 round-trip 測試釘死）、`index.db` 是純投影——`distill reindex` 隨時全量重建，且 rebuild 有交易保護與 corrupt 檔容錯。

**達成效果**：trigram 升級時直接砍掉重建 FTS 表，16 條記憶零損失、前後統計完全一致——「索引可拋棄」從理論變成實際走過的遷移路徑。開發過程中 reviewer 徒手翻記憶檔做驗證（如確認治理演練後禁令原封不動），這種「用眼睛稽核」在 DB-resident 方案裡根本做不到。

---

## 6. 證據引用 + 錨點驗證 ← Generative Agents

**原始設計**：Stanford Generative Agents 的 reflection 機制要求每條歸納出的洞見**引用它所依據的原始記憶**——洞見樹的每一層都可以往下追溯到最底層的觀察。

**好在哪**：引用讓記憶**可稽核**（這條教訓從哪來的？點開看原文）並且**可驗證**——而可驗證是關鍵：引用如果只是裝飾，模型會捏造它。把「引用必須真實存在」變成硬性檢查，就把 LLM 幻覺從「無法防範的風險」變成「可程式化攔截的錯誤類別」。

**我們的落地**：collector 在 transcript 每一輪標 `{#msg_id}` 錨點（真實的 opencode message id）；抽取 prompt 要求 evidence 引用錨點；`validateCandidates()` 對每個引用查 `anchorsIn(body)`——**引用不到真實錨點，整條候選拒收**。這是全系統唯一「一票否決」的驗證規則。配套的寬容處理：模型自然回傳 `#msg_x`（帶井號）時先無損正規化再比對（實測發現的坑：嚴格比對曾誤殺 2/3 真實 run 的候選）。

**達成效果**：真實夜跑中 LLM 憑空捏造的錨點被當場攔截（log 可查：`rejected candidate: hallucinated evidence anchor: msg_c5cd...`）；店裡 18 條 active 記憶每一條的 evidence 都可以點回原始對話的具體輪次。「這條記憶哪來的」永遠有答案。

---

## 7. 證據數驅動 confidence + 對比抽取 ← ExpeL

**原始設計**：ExpeL 維護一份洞見清單，用 ADD / UPVOTE / DOWNVOTE / EDIT 演化——被多條軌跡獨立驗證的洞見票數上升，反覆被推翻的自然出局。另一個貢獻：**對比成功與失敗的軌跡**來抽取「為什麼這樣才對」。

**好在哪**：confidence 如果讓 LLM 自己打分，就是又一個會漂移的主觀值；ExpeL 的票數本質上是**用客觀事件（幾個獨立來源證實過）代替主觀評分**。對比抽取則直指工程知識的最高訊號源——「先錯後對」的完整弧線比單獨的成功或失敗都有價值十倍。

**我們的落地**：confidence 是**決定論公式**不是 LLM 評分——`0.5 + 0.15×(獨立session數−1) + 0.2×人工核可 − 0.25×被反駁`，clamp [0.1, 0.95]（`computeConfidence()`，有 pinning test 釘死每個值）。對比抽取寫進 prompt 規則：「session 中若有失敗後被修正的嘗試，抽取**對比**（錯在哪、怎麼修好的），不要只抽失敗」。MCP 預設只出 confidence ≥ 0.5，`include_tentative` 才放低信心條目。

**達成效果**：單次出現的記憶誠實地停在 0.5（「一個人說的」）；PPA 實測中被第二個 session 佐證的條目自動升 0.65；人工 approve 直接 +0.2。分數的每一分都能回答「為什�麼是這個數字」——這在 LLM 自評分的系統裡做不到。

---

## 8. Trigger/Lesson 分離 + 專案隔離與升級 ← ECC continuous-learning「instinct」系統

**原始設計**：本機安裝的 everything-claude-code plugin 的 instinct 學習系統——每條「直覺」有獨立的 `trigger`（什麼情境下適用）與 action；儲存**以專案為界**，同一模式在 2+ 個專案出現才升級為全域。

**好在哪**：trigger/lesson 分離是檢索設計的巧思——**trigger 是給檢索匹配的（「什麼時候該想起我」），lesson 是給注入的（「想起我之後照這個做」）**，混在一起兩頭都做不好。專案隔離則直擊 IC 設計的現實：每顆 chip、每套 PDK 的知識絕不能互相污染，但「跨專案都成立的教訓」又應該共享——需要一條有門檻的升級通道，而不是全域大鍋炒。

**我們的落地**：memory entry 的 frontmatter 有獨立的 `trigger` 欄位（FTS 索引欄之一）；store 以 `memories/<project-slug>/` 分目錄，檢索可加 project 過濾；reconcile 偵測到跨專案 UPDATE 時自動標註 `promotion candidate` note（升級本身留給人/未來的 REFLECT 決定——保守設計）。

**達成效果**：搜尋命中後 agent 看到的是「when hold slack degrades after an ECO route」這種情境句，而不是一段要自己解析的敘述；`search_memory` 支援 project 參數讓 chip-A 的查詢不會撈到 chip-B 的 PDK 細節。閉環實測中 agent 正確引用 trigger 判斷了相關性。

---

## 9. 只對 volatile 事實衰減 ← MemoryBank（反面教訓）

**原始設計**：MemoryBank 對所有記憶套 Ebbinghaus 遺忘曲線——召回強化、閒置衰減，像人類記憶一樣「用進廢退」。

**好在哪／壞在哪**：這對聊天陪伴型 agent 合理，**對工程知識是錯的**——一條很少被查的根因分析依然是真的；「三個月沒人問」不構成遺忘一條 tapeout 教訓的理由。但它反過來提醒了一類真實需求：**有時效性的事實**（「我們目前在 PDK v1.2」「工具 X 現在有 bug」）確實會過期。2026 年的業界共識（Hindsight 等）正是：衰減只施加於時間敏感的宣稱。

**我們的落地**：抽取 schema 有 `volatile: boolean` 欄位，由 LLM 在抽取時標記（prompt 明確定義：工具版本、當前 bug、WIP 狀態才算 volatile）；永久性教訓（root_cause、多數 pitfall）標 false，永不衰減。`access_count`/`last_accessed` 已在 index 記錄（MemoryBank 的「召回強化」訊號），供未來的衰減 sweep 與排序加權使用。

**達成效果**：分類已在運作（PPA 六條記憶全部正確標 `volatile: false`——時序收斂教訓不會過期）；衰減執行器本身刻意留白（backlog），因為在店只有幾十條的階段，錯誤的自動清理比沒有清理危險得多——這個順序判斷本身也是從 MemoryBank 的教訓學來的。

---

## 另外兩個較小但值得記錄的借用

**MIRIX 的記憶分類學**：episodic / semantic / procedural 三層 `memory_class`——workflow 型記憶標 procedural（承 Voyager 的教訓：程序性知識要盡量存成可執行的具體步驟），其餘標 semantic。目前主要是元資料，為未來「procedural 記憶直接轉 runbook」預留形狀。

**資料工程的 ledger 冪等模式**（checkpoint/watermark 慣例）：`processed_sessions` 表以 `(session_id, content_hash, pipeline_version)` 為主鍵——同內容不重跑（省 LLM 錢）、內容變了自動重跑（session 續聊後 hash 變）、prompt 大改時 bump pipeline_version 就能安全地全量重蒸餾（調和層擋重複）。實測：全量夜跑後立即重跑，`already-done` 全數命中、LLM call 為零。

---

## 收束：這張拼圖為什麼成立

九個借用各自解決一個正交的問題：

```
內容形狀   ← LangMem typed schema（抽成什麼樣）
內容品質   ← Generative Agents 錨點驗證（防幻覺）+ ExpeL 對比抽取（抽最有價值的）
儲存一致性 ← Mem0 調和迴圈（防重複矛盾）+ Graphiti supersession（防歷史銷毀）
成本結構   ← Letta sleep-time（強模型花在刀口）+ ledger 冪等（不重複付費）
載體與整合 ← Claude Code/MemFS 檔案為本（人可稽核、wiki 零成本）
檢索精度   ← ECC trigger 分離 + 專案隔離（對的知識在對的時候出現）
時間正確性 ← MemoryBank 反面教訓（該過期的過期，不該過期的永存）
```

而把它們黏合起來的兩塊原創部分——**政策記憶的人審治理**（decision/convention 的任何變動必過人）與**確定性回歸評測**（換模型的保險絲）——恰好是調查中沒有任何現成方案提供的。這就是「借用而非採用」策略的完整形狀：站在被驗證過的設計上，只發明市場上真正缺的那兩塊。

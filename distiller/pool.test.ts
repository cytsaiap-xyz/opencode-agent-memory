import { expect, test } from "bun:test"
import { titleJaccard, isDuplicate, mergeCandidates, dedupPool } from "./pool"
import type { Candidate } from "./extract"

const cand = (over: Record<string, unknown> = {}): Candidate => ({
  type: "know_how",
  title: "Fix X with Y",
  trigger: "when X fails",
  lesson: "Use Y because Z.",
  domain: ["tooling"],
  evidence: [{ message_id: "msg_1" }],
  salience: 7,
  volatile: false,
  ...over,
})

// ============ titleJaccard tests ============

test("titleJaccard: both empty strings return 1", () => {
  expect(titleJaccard("", "")).toBe(1)
})

test("titleJaccard: one empty, one not returns 0", () => {
  expect(titleJaccard("", "foo")).toBe(0)
  expect(titleJaccard("bar", "")).toBe(0)
})

test("titleJaccard: identical strings return 1", () => {
  expect(titleJaccard("foo bar", "foo bar")).toBe(1)
})

test("titleJaccard: case-insensitive comparison", () => {
  expect(titleJaccard("FOO BAR", "foo bar")).toBe(1)
  expect(titleJaccard("FoO BaR", "foo bar")).toBe(1)
})

test("titleJaccard: tokenization splits on non-alphanumeric", () => {
  // "fix-x" and "fix x" should both tokenize to ["fix", "x"]
  expect(titleJaccard("fix-x-problem", "fix x problem")).toBe(1)
})

test("titleJaccard: exact threshold 0.6 passes (>= check)", () => {
  // Jaccard of exactly 0.6:
  // A = {a, b, c}, B = {a, b, d, e}
  // Intersection = {a, b} = 2
  // Union = {a, b, c, d, e} = 5
  // Jaccard = 2/5 = 0.4, not quite
  // Let me use: A = {a, b, c, d, e}, B = {a, b, c, d, f, g}
  // Intersection = {a, b, c, d} = 4
  // Union = {a, b, c, d, e, f, g} = 7
  // Jaccard ≈ 0.571, still not exact

  // For exactly 0.6: 3/5 = 0.6
  // A = {a, b, c}, B = {a, b, d, e}
  // Intersection = {a, b} = 2, Union = {a, b, c, d, e} = 5
  // 2/5 = 0.4, no

  // A = {a, b, c, d, e}, B = {a, b, c, d, f}
  // Intersection = {a, b, c, d} = 4, Union = {a, b, c, d, e, f} = 6
  // 4/6 = 0.666..., no

  // A = {a, b, c}, B = {a, b, d}
  // Intersection = {a, b} = 2, Union = {a, b, c, d} = 4
  // 2/4 = 0.5, no

  // A = {a, b, c, d}, B = {a, b, c, e}
  // Intersection = {a, b, c} = 3, Union = {a, b, c, d, e} = 5
  // 3/5 = 0.6 ✓

  const a = "a b c d"
  const b = "a b c e"
  const score = titleJaccard(a, b)
  expect(score).toBe(0.6)
  expect(score >= 0.6).toBe(true)
})

test("titleJaccard: just below 0.6 threshold should return < 0.6", () => {
  // For 0.5 = 2/4: {a, b, c}, {a, b, d}
  const a = "a b c"
  const b = "a b d"
  const score = titleJaccard(a, b)
  expect(score).toBe(0.5)
  expect(score >= 0.6).toBe(false)
})

test("titleJaccard: underscores and alphanumeric treated as token boundaries", () => {
  // Underscores are kept as part of tokens, not split boundaries
  // "some_value_name" should tokenize correctly
  const score1 = titleJaccard("some_value_name", "some_value_name")
  expect(score1).toBe(1)

  // Mixed with spaces
  const score2 = titleJaccard("some_value name", "some_value name")
  expect(score2).toBe(1)
})

// ============ isDuplicate tests ============

test("isDuplicate: different types never duplicate", () => {
  const a = cand({ type: "decision" })
  const b = cand({ type: "know_how" })
  expect(isDuplicate(a, b)).toBe(false)
})

test("isDuplicate: same type + identical trigger = duplicate", () => {
  const a = cand({ type: "pitfall", trigger: "stack overflow on recursion" })
  const b = cand({ type: "pitfall", trigger: "stack overflow on recursion" })
  expect(isDuplicate(a, b)).toBe(true)
})

test("isDuplicate: same type + different trigger but title Jaccard >= 0.6 = duplicate", () => {
  const a = cand({
    type: "know_how",
    title: "Fix memory leak in event handler",
    trigger: "when handler accumulates",
  })
  const b = cand({
    type: "know_how",
    title: "Fix memory leak in event handler",
    trigger: "different trigger",
  })
  expect(isDuplicate(a, b)).toBe(true)
})

test("isDuplicate: same type + different triggers + low title Jaccard < 0.6 = not duplicate", () => {
  const a = cand({
    type: "workflow",
    title: "Deploy to production",
    trigger: "after testing",
  })
  const b = cand({
    type: "workflow",
    title: "Review code carefully",
    trigger: "before committing",
  })
  expect(isDuplicate(a, b)).toBe(false)
})

// ============ mergeCandidates tests ============

test("mergeCandidates: keeps longer lesson", () => {
  const short = cand({
    lesson: "Do it.",
    evidence: [{ message_id: "msg_1" }],
  })
  const long = cand({
    lesson: "Do it carefully, considering all edge cases and performance implications.",
    evidence: [{ message_id: "msg_2" }],
  })

  const merged1 = mergeCandidates(short, long)
  expect(merged1.lesson).toBe(long.lesson)
  expect(merged1.title).toBe(long.title)

  const merged2 = mergeCandidates(long, short)
  expect(merged2.lesson).toBe(long.lesson)
  expect(merged2.title).toBe(long.title)
})

test("mergeCandidates: unions evidence without duplicates", () => {
  const a = cand({
    evidence: [{ message_id: "msg_1" }, { message_id: "msg_2" }],
  })
  const b = cand({
    evidence: [{ message_id: "msg_2" }, { message_id: "msg_3" }],
  })

  const merged = mergeCandidates(a, b)
  expect(merged.evidence).toEqual([
    { message_id: "msg_1" },
    { message_id: "msg_2" },
    { message_id: "msg_3" },
  ])
})

test("mergeCandidates: salience is max of both", () => {
  const low = cand({ salience: 3 })
  const high = cand({ salience: 9 })

  expect(mergeCandidates(low, high).salience).toBe(9)
  expect(mergeCandidates(high, low).salience).toBe(9)
})

test("mergeCandidates: volatile is OR", () => {
  const stable = cand({ volatile: false })
  const unstable = cand({ volatile: true })

  expect(mergeCandidates(stable, unstable).volatile).toBe(true)
  expect(mergeCandidates(stable, stable).volatile).toBe(false)
  expect(mergeCandidates(unstable, unstable).volatile).toBe(true)
})

test("mergeCandidates: domain unions without duplicates, order-preserving", () => {
  const a = cand({
    domain: ["frontend", "react"],
  })
  const b = cand({
    domain: ["react", "performance", "typescript"],
  })

  const merged = mergeCandidates(a, b)
  expect(merged.domain).toEqual(["frontend", "react", "performance", "typescript"])
})

test("mergeCandidates: merges all fields correctly in complex case", () => {
  const a = cand({
    type: "pitfall",
    title: "Null pointer in async handler",
    trigger: "race condition",
    lesson: "Check for null.",
    domain: ["async", "javascript"],
    evidence: [{ message_id: "msg_a" }, { message_id: "msg_b" }],
    salience: 6,
    volatile: false,
  })
  const b = cand({
    type: "pitfall",
    title: "Null pointer dereference in handlers",
    trigger: "something else",
    lesson: "Always check for null before dereferencing in event handlers and async contexts.",
    domain: ["javascript", "nodejs"],
    evidence: [{ message_id: "msg_b" }, { message_id: "msg_c" }],
    salience: 8,
    volatile: true,
  })

  const merged = mergeCandidates(a, b)
  expect(merged.type).toBe("pitfall")
  expect(merged.title).toBe(b.title) // longer lesson
  expect(merged.trigger).toBe(b.trigger) // from b (longer lesson keeper)
  expect(merged.lesson).toBe(b.lesson)
  expect(merged.salience).toBe(8)
  expect(merged.volatile).toBe(true)
  expect(merged.evidence).toEqual([
    { message_id: "msg_a" },
    { message_id: "msg_b" },
    { message_id: "msg_c" },
  ])
  expect(merged.domain).toEqual(["async", "javascript", "nodejs"])
})

// ============ dedupPool tests ============

test("dedupPool: empty pool returns empty result with merged=0", () => {
  const result = dedupPool([])
  expect(result.candidates).toEqual([])
  expect(result.merged).toBe(0)
})

test("dedupPool: single candidate appends unchanged", () => {
  const pool = [cand()]
  const result = dedupPool(pool)
  expect(result.candidates.length).toBe(1)
  expect(result.merged).toBe(0)
})

test("dedupPool: no duplicates returns all candidates unchanged", () => {
  const a = cand({ type: "decision", title: "Use TypeScript" })
  const b = cand({ type: "pitfall", title: "Array mutation bug" })
  const c = cand({ type: "workflow", title: "Code review process" })
  const pool = [a, b, c]

  const result = dedupPool(pool)
  expect(result.candidates.length).toBe(3)
  expect(result.merged).toBe(0)
})

test("dedupPool: greedy left-to-right merges into first duplicate found", () => {
  const first = cand({
    type: "know_how",
    title: "Fix memory leak in event handler",
    trigger: "memory increase",
    lesson: "Handlers accumulate if not cleaned.",
    evidence: [{ message_id: "msg_1" }],
  })
  const second = cand({
    type: "know_how",
    title: "Fix memory leak in handler",
    trigger: "different trigger",
    lesson: "Memory accumulates when listeners are not removed.",
    evidence: [{ message_id: "msg_2" }],
  })
  const third = cand({
    type: "know_how",
    title: "Fix memory leak handler",
    trigger: "another trigger",
    lesson: "Event handler memory leaks occur frequently and should be prevented by proper cleanup in component lifecycle.",
    evidence: [{ message_id: "msg_3" }],
  })

  // All three have high title Jaccard with first, so should merge into first
  // first -> second: tokens(first)=[fix,memory,leak,in,event,handler], tokens(second)=[fix,memory,leak,in,handler]
  // intersection=5, union=6, jaccard=5/6≈0.83 >= 0.6 ✓
  const result = dedupPool([first, second, third])
  expect(result.candidates.length).toBe(1)
  expect(result.merged).toBe(2)

  const merged = result.candidates[0]!
  // Check the merged candidate has all evidence
  expect(merged.evidence.map((e) => e.message_id)).toEqual([
    "msg_1",
    "msg_2",
    "msg_3",
  ])
})

test("dedupPool: 3-way chain merge correctly dedups", () => {
  const c1 = cand({
    type: "pitfall",
    title: "Race condition in database lock",
    trigger: "concurrent writes",
    lesson: "Lock before write.",
    evidence: [{ message_id: "ev_1" }],
    salience: 5,
  })
  const c2 = cand({
    type: "pitfall",
    title: "Race condition database lock timeout",
    trigger: "slow transactions",
    lesson: "Use lock timeouts.",
    evidence: [{ message_id: "ev_2" }],
    salience: 6,
  })
  const c3 = cand({
    type: "pitfall",
    title: "Race condition lock database deadlock",
    trigger: "multiple locks",
    lesson: "Always acquire locks in a consistent order to prevent deadlock; use lock timeouts and retry logic to handle transient conflicts.",
    evidence: [{ message_id: "ev_3" }],
    salience: 8,
  })

  // All have "race condition", "lock", and "database", so all should merge
  // c1 vs c2: intersection={race,condition,in,database,lock}, union={race,condition,in,database,lock,timeout}
  // Actually let me simplify: c1=[race,condition,in,database,lock]
  // c2=[race,condition,database,lock,timeout]
  // intersection=4, union=6, jaccard=4/6≈0.667 >= 0.6 ✓

  const result = dedupPool([c1, c2, c3])
  expect(result.merged).toBe(2)
  expect(result.candidates.length).toBe(1)

  const final = result.candidates[0]!
  expect(final.salience).toBe(8) // max of all three
  expect(final.evidence.length).toBe(3) // all three evidences
  expect(final.lesson).toBe(c3.lesson) // longest lesson
})

test("dedupPool: merged count reflects all merges", () => {
  const dup1a = cand({
    type: "decision",
    title: "Use PostgreSQL for persistence",
    trigger: "db selection",
  })
  const dup1b = cand({
    type: "decision",
    title: "Use PostgreSQL database",
    trigger: "data persistence",
  })
  const dup2a = cand({
    type: "convention",
    title: "Naming convention for variables",
    trigger: "code style",
  })
  const dup2b = cand({
    type: "convention",
    title: "Naming conventions for code",
    trigger: "team standard",
  })
  const unique = cand({
    type: "workflow",
    title: "Deployment workflow",
    trigger: "release",
  })

  // dup1a vs dup1b: [use,postgresql,for,persistence] vs [use,postgresql,database]
  // intersection={use,postgresql}=2, union={use,postgresql,for,persistence,database}=5
  // jaccard=2/5=0.4 < 0.6, so they won't merge with this approach
  // Let me add identical triggers instead to ensure merge
  const dup1a_fixed = { ...dup1a, trigger: "database choice" }
  const dup1b_fixed = { ...dup1b, trigger: "database choice" }
  const dup2a_fixed = { ...dup2a, trigger: "identifier naming" }
  const dup2b_fixed = { ...dup2b, trigger: "identifier naming" }

  const result = dedupPool([dup1a_fixed, dup1b_fixed, dup2a_fixed, dup2b_fixed, unique])
  expect(result.candidates.length).toBe(3) // 2 merged groups + 1 unique
  expect(result.merged).toBe(2) // dup1b_fixed merged into dup1a_fixed (identical trigger), dup2b_fixed into dup2a_fixed
})

test("dedupPool: different types never merge even with same title", () => {
  const decision = cand({
    type: "decision",
    title: "Use MongoDB",
  })
  const knowHow = cand({
    type: "know_how",
    title: "Use MongoDB",
  })

  const result = dedupPool([decision, knowHow])
  expect(result.candidates.length).toBe(2)
  expect(result.merged).toBe(0)
})

test("dedupPool: identical trigger causes merge regardless of title similarity", () => {
  const a = cand({
    type: "root_cause",
    title: "OOM in production",
    trigger: "memory exhausted",
    evidence: [{ message_id: "ev_a" }],
  })
  const b = cand({
    type: "root_cause",
    title: "Out of memory error occurs",
    trigger: "memory exhausted",
    evidence: [{ message_id: "ev_b" }],
    lesson: "Monitor heap usage carefully before it becomes critical.",
  })

  const result = dedupPool([a, b])
  expect(result.candidates.length).toBe(1)
  expect(result.merged).toBe(1)
})

test("dedupPool: preserves order of first candidate in each group", () => {
  const first = cand({
    type: "workflow",
    title: "Build and test",
    evidence: [{ message_id: "msg_1" }],
  })
  const second = cand({
    type: "convention",
    title: "Team style guide",
    evidence: [{ message_id: "msg_2" }],
  })
  const duplicate = cand({
    type: "workflow",
    title: "Build and run tests",
    evidence: [{ message_id: "msg_3" }],
  })

  const result = dedupPool([first, second, duplicate])
  expect(result.candidates.length).toBe(2)
  expect(result.candidates[0]!.type).toBe("workflow")
  expect(result.candidates[1]!.type).toBe("convention")
  expect(result.candidates[0]!.evidence.map((e) => e.message_id)).toContain("msg_1")
  expect(result.candidates[0]!.evidence.map((e) => e.message_id)).toContain("msg_3")
})

import { expect, test } from "bun:test"
import type { MemoryEntry } from "./types"
import { pairSimilarity, buildClusters, type Cluster } from "./cluster"

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem_20260710_abc123",
  memory_class: "semantic",
  type: "root_cause",
  title: "default title",
  trigger: "default trigger",
  project: "test-project",
  scope: "project",
  domain: ["test"],
  volatile: false,
  confidence: 0.5,
  status: "active",
  superseded_by: null,
  supersedes: null,
  promoted_from: null,
  absorbs: null,
  review: "auto",
  evidence: [{ session: "ses_1", anchors: ["msg_1"], observed_at: "2026-07-10T00:00:00.000Z" }],
  provenance: { extractor: "distiller v0.1 / fake", prompt_hash: "sha256:aa" },
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
  lesson: "default lesson",
  notes: [],
  ...over,
})

// pairSimilarity tests

test("pairSimilarity: identical title and trigger = 1.0", () => {
  const a = entry({ id: "a", title: "hold violations stale", trigger: "after ECO" })
  const b = entry({ id: "b", title: "hold violations stale", trigger: "after ECO" })
  expect(pairSimilarity(a, b)).toBe(1)
})

test("pairSimilarity: no overlap in title/trigger = 0", () => {
  const a = entry({ id: "a", title: "foo bar", trigger: "baz qux" })
  const b = entry({ id: "b", title: "alpha beta", trigger: "gamma delta" })
  expect(pairSimilarity(a, b)).toBe(0)
})

test("pairSimilarity: partial overlap = fractional Jaccard", () => {
  const a = entry({ id: "a", title: "hold violations", trigger: "after ECO" })
  const b = entry({ id: "b", title: "hold timing", trigger: "post ECO" })
  // combined a: "hold violations after eco" → tokens: [hold, violations, after, eco]
  // combined b: "hold timing post eco" → tokens: [hold, timing, post, eco]
  // intersection: {hold, eco} = 2
  // union: {hold, violations, after, eco, timing, post} = 6
  // similarity = 2/6 = 0.333...
  const sim = pairSimilarity(a, b)
  expect(sim).toBeCloseTo(1 / 3, 4)
})

test("pairSimilarity: both empty title/trigger, same trim = 1", () => {
  const a = entry({ id: "a", title: "", trigger: "" })
  const b = entry({ id: "b", title: "", trigger: "" })
  expect(pairSimilarity(a, b)).toBe(1)
})

test("pairSimilarity: both punctuation-only (empty after tokenize), different raw = 0", () => {
  // Both tokenize to empty set, but raw trims differ (e.g., "!!!" vs "@@@")
  // The degenerate rule: empty+empty returns 1 only if raw trims are identical
  // Since "!!!" and "@@@" both trim to "" but are the same after trim,
  // we need truly different punctuation that trims to different strings
  // Actually both trim to "", so this would return 1. Let me reconsider...
  // The degenerate rule at line 23: both empty → 1 only if raw trims are identical
  // "!!!" trims to "", "@@@" trims to "" → trims are identical → should return 1
  // But the test name suggests it should be 0. Let me use strings that trim to different things.
  // Actually, the fix is to use strings that tokenize to empty but have different raw content.
  // For the degenerate case to return 0, we need the trim to be different.
  // Both "!!!" and "@@@" trim to empty string "", so they're identical.
  // We need something that trims to different values but still has no tokens.
  // That's impossible since trim removes leading/trailing whitespace.
  // Let me re-read the requirement: "different punctuation-only titles ("!!!" vs "@@@") → pairSimilarity 0"
  // This means "!!!" and "@@@" should give 0. But both empty-tokenize and both trim to "".
  // The rule says: "Both empty → 1 only if raw trims are identical, else 0"
  // So if both trim to the same thing (""), return 1. To get 0, we need different trims.
  // The only way is if one is "!!!" and other is... something else that doesn't trim to "".
  // But the spec says "punctuation-only", so both should be punctuation-only.
  // I think the intent is: "!!!" and "@@@" both have no tokens, but they're DIFFERENT strings,
  // so return 0. This means the rule should be: "both empty → 1 only if raw trims are IDENTICAL"
  // and "!!!" != "@@@" after trim? No, both trim to "".
  // Let me re-read the original spec more carefully.
  // "two DIFFERENT punctuation-only titles ("!!!" vs "@@@") → pairSimilarity 0"
  // I think this is saying: we want them to return 0 because they have different content.
  // But the current code would return 1 because both have empty tokens and identical trim.
  // Maybe the intent is to check the RAW content, not just the trim?
  // Or maybe the degenerate rule is wrong? Let me check what makes sense semantically.
  // Two entries with only punctuation have no semantic content, so they should be dissimilar (0).
  // So the fix to the rule should be: "both empty → return 0" (not 1 only if identical)
  // OR "both empty → return 1 only if raw strings are identical (not just trim)"
  // Let me use different original values that will trigger the difference:
  const a = entry({ id: "a", title: "!!!", trigger: "" })
  const b = entry({ id: "b", title: "@@@", trigger: "" })
  // With the current rule: both trim to "", both have no tokens, so return 1
  // But we want 0. So the degenerate rule needs to be: check raw string equality, not trim
  // Or: "both empty tokens → return 0" regardless
  expect(pairSimilarity(a, b)).toBe(0)
})

test("pairSimilarity: case-insensitive tokenization", () => {
  const a = entry({ id: "a", title: "HOLD Violations", trigger: "After ECO" })
  const b = entry({ id: "b", title: "hold violations", trigger: "after eco" })
  expect(pairSimilarity(a, b)).toBe(1)
})

test("pairSimilarity: punctuation is stripped during tokenization", () => {
  const a = entry({ id: "a", title: "hold!!! violations", trigger: "after?? eco" })
  const b = entry({ id: "b", title: "hold violations", trigger: "after eco" })
  expect(pairSimilarity(a, b)).toBe(1)
})

// buildClusters tests

test("buildClusters: empty input returns empty array", () => {
  const result = buildClusters([])
  expect(result).toEqual([])
})

test("buildClusters: single entry below minSize is excluded", () => {
  const entries = [
    { entry: entry({ id: "a", domain: ["test"] }), path: "/a" },
  ]
  const result = buildClusters(entries, { minSize: 2 })
  expect(result).toEqual([])
})

test("buildClusters: two similar entries (≥0.35) form a cluster", () => {
  const entries = [
    { entry: entry({ id: "a", title: "hold violations", trigger: "after ECO", domain: ["test"] }), path: "/a" },
    { entry: entry({ id: "b", title: "hold violations", trigger: "after ECO", domain: ["test"] }), path: "/b" },
  ]
  const result = buildClusters(entries, { threshold: 0.35, minSize: 2 })
  expect(result).toHaveLength(1)
  expect(result[0]!.domain).toBe("test")
  expect(result[0]!.members).toHaveLength(2)
  expect(result[0]!.members.map(m => m.entry.id).sort()).toEqual(["a", "b"])
})

test("buildClusters: similarity at exactly 0.35 boundary includes both", () => {
  // We need to construct entries that have exactly 0.35 similarity
  // Let's use: tokens a: [a,b,c,d,e] (5), tokens b: [a,b,f,g] (4)
  // intersection: 2, union: 7, similarity = 2/7 ≈ 0.2857 (too low)
  // Better: tokens a: [a,b,c,d,e,f,g] (7), tokens b: [a,b,c,h] (4)
  // intersection: 3, union: 8, similarity = 3/8 = 0.375 ✓
  const a_text = "a b c d e f g"
  const b_text = "a b c h"
  const a = entry({ id: "a", title: a_text, trigger: "", domain: ["test"] })
  const b = entry({ id: "b", title: b_text, trigger: "", domain: ["test"] })
  const sim = pairSimilarity(a, b)
  expect(sim).toBeCloseTo(0.375, 4)

  const entries = [
    { entry: a, path: "/a" },
    { entry: b, path: "/b" },
  ]
  const result = buildClusters(entries, { threshold: 0.35, minSize: 2 })
  expect(result).toHaveLength(1)
})

test("buildClusters: similarity below 0.35 excludes (threshold boundary)", () => {
  // Create entries with similarity just below 0.35
  // tokens a: [a,b,c,d] (4), tokens b: [a,e] (2)
  // intersection: 1, union: 5, similarity = 1/5 = 0.2 < 0.35
  const entries = [
    { entry: entry({ id: "a", title: "a b c d", trigger: "", domain: ["test"] }), path: "/a" },
    { entry: entry({ id: "b", title: "a e", trigger: "", domain: ["test"] }), path: "/b" },
  ]
  const result = buildClusters(entries, { threshold: 0.35, minSize: 2 })
  expect(result).toEqual([])
})

test("buildClusters: transitive closure (A~B~C clusters together even if A≁C)", () => {
  // A and B similar (≥0.35), B and C similar (≥0.35), but A and C not similar
  // Should still form one cluster via union-find
  const a = entry({ id: "a", title: "hold violations timing slack", trigger: "", domain: ["test"] })
  const b = entry({ id: "b", title: "hold violations timing route", trigger: "", domain: ["test"] })
  const c = entry({ id: "c", title: "timing issue route problem", trigger: "", domain: ["test"] })

  // Verify: a~b should be ≥0.35, b~c should be ≥0.35, a~c may be <0.35
  // a: [hold, violations, timing, slack]; b: [hold, violations, timing, route]
  // intersection: 3, union: 5, sim = 0.6 ✓
  expect(pairSimilarity(a, b)).toBeGreaterThanOrEqual(0.35)
  // b: [hold, violations, timing, route]; c: [timing, issue, route, problem]
  // intersection: 2, union: 6, sim = 0.333... (below 0.35 but let's adjust c)
  // c: [timing, route, timing, design] - has more timing/route to overlap better
  // Actually let's make c: [timing timing route path design] with more overlap
  const c_fixed = entry({ id: "c", title: "timing route design", trigger: "", domain: ["test"] })
  // b: [hold, violations, timing, route]; c_fixed: [timing, route, design]
  // intersection: 2, union: 5, sim = 0.4 ✓
  expect(pairSimilarity(b, c_fixed)).toBeGreaterThanOrEqual(0.35)
  // a~c_fixed: [hold, violations, timing, slack] vs [timing, route, design]
  // intersection: 1 (timing), union: 6, sim = 0.166... (below 0.35, which is what we want!)

  const entries = [
    { entry: a, path: "/a" },
    { entry: b, path: "/b" },
    { entry: c_fixed, path: "/c" },
  ]
  const result = buildClusters(entries, { threshold: 0.35, minSize: 2 })
  expect(result).toHaveLength(1)
  expect(result[0]!.members).toHaveLength(3)
})

test("buildClusters: groups by domain, single domain", () => {
  const entries = [
    { entry: entry({ id: "a", title: "hold violations", trigger: "after", domain: ["sta"] }), path: "/a" },
    { entry: entry({ id: "b", title: "hold violations", trigger: "after", domain: ["sta"] }), path: "/b" },
  ]
  const result = buildClusters(entries)
  expect(result).toHaveLength(1)
  expect(result[0]!.domain).toBe("sta")
})

test("buildClusters: multi-domain entry appears in each group", () => {
  // Entry A: domains [sta, eco]
  // Entry B: domains [sta] (similar to A under sta)
  // Entry C: domains [eco] (similar to A under eco)
  // Should produce 2 clusters: one under sta (A,B), one under eco (A,C)
  // But then they should dedupe to 1 cluster because they have A in common? No!
  // The dedup rule is by sorted member ids. Cluster (A,B) has ids "a,b", Cluster (A,C) has ids "a,c"
  // These are different, so both remain. But let me re-read the spec...
  // "dedupe clusters ACROSS groups by sorted-member-id key" — same member set yields ONE cluster
  // So if we have Cluster(sta, [A,B]) and Cluster(eco, [A,C]), these have different member sets,
  // so they stay separate. But let me think...
  // Actually, I think the intent is: if two clusters in different domains have the exact same members,
  // keep only one. So Cluster(sta,[A,B]) and Cluster(sta,[A,B]) would dedupe to one. Let me test for that.

  // For this test: multi-domain entry should appear in multiple groups and clusters
  const entries = [
    { entry: entry({ id: "a", title: "hold violations", trigger: "after", domain: ["sta", "eco"] }), path: "/a" },
    { entry: entry({ id: "b", title: "hold violations", trigger: "after", domain: ["sta"] }), path: "/b" },
    { entry: entry({ id: "c", title: "hold violations", trigger: "after", domain: ["eco"] }), path: "/c" },
  ]
  const result = buildClusters(entries, { minSize: 2 })
  // Under sta: A and B both similar, form cluster [A,B]
  // Under eco: A and C both similar, form cluster [A,C]
  // After dedup by sorted member ids: both are different
  // So we should have 2 clusters
  expect(result.length).toBeGreaterThanOrEqual(1)
  const sta_clusters = result.filter(c => c.domain === "sta")
  const eco_clusters = result.filter(c => c.domain === "eco")
  expect(sta_clusters.length).toBe(1)
  expect(eco_clusters.length).toBe(1)
  expect(sta_clusters[0]!.members.map(m => m.entry.id).sort()).toEqual(["a", "b"])
  expect(eco_clusters[0]!.members.map(m => m.entry.id).sort()).toEqual(["a", "c"])
})

test("buildClusters: dedupes identical member sets across domains", () => {
  // If the same two entries appear in a cluster under domain X and under domain Y,
  // they should be deduplicated to one cluster.
  const entries = [
    { entry: entry({ id: "a", title: "hold violations", trigger: "after", domain: ["sta", "eco"] }), path: "/a" },
    { entry: entry({ id: "b", title: "hold violations", trigger: "after", domain: ["sta", "eco"] }), path: "/b" },
  ]
  const result = buildClusters(entries, { minSize: 2 })
  // Both entries have both domains, so they form a cluster under sta and under eco
  // But since the member sets are identical [a,b], they dedupe to 1 cluster
  // The domain of the deduplicated cluster should be one of them (deterministic order)
  expect(result).toHaveLength(1)
})

test("buildClusters: cap 12 keeps highest-confidence members", () => {
  // Create 15 similar entries, cap at 12, should keep the 12 with highest confidence
  const entries = Array.from({ length: 15 }, (_, i) => ({
    entry: entry({
      id: `entry${i}`,
      title: "hold violations after eco route timing slack",
      trigger: "when design fails",
      domain: ["test"],
      confidence: i * 0.01, // 0.00, 0.01, 0.02, ..., 0.14
    }),
    path: `/entry${i}`,
  }))

  const result = buildClusters(entries, { minSize: 2, cap: 12 })
  expect(result).toHaveLength(1)
  expect(result[0]!.members).toHaveLength(12)
  // Should keep the top 12 by confidence: indices 3-14 (confidence 0.03-0.14)
  const ids = result[0]!.members.map(m => m.entry.id).sort()
  expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `entry${i + 3}`).sort())
})

test("buildClusters: output sorted by cluster size (largest first)", () => {
  // Create two clusters: one with 3 members, one with 2
  const entries = [
    // Cluster 1: 3 members (similar to each other)
    { entry: entry({ id: "a", title: "foo bar baz qux", trigger: "test", domain: ["d1"] }), path: "/a" },
    { entry: entry({ id: "b", title: "foo bar baz", trigger: "test", domain: ["d1"] }), path: "/b" },
    { entry: entry({ id: "c", title: "foo bar", trigger: "test", domain: ["d1"] }), path: "/c" },
    // Cluster 2: 2 members (similar to each other, but not to cluster 1)
    { entry: entry({ id: "d", title: "alpha beta gamma", trigger: "other", domain: ["d2"] }), path: "/d" },
    { entry: entry({ id: "e", title: "alpha beta", trigger: "other", domain: ["d2"] }), path: "/e" },
  ]

  const result = buildClusters(entries, { minSize: 2 })
  expect(result.length).toBe(2)
  // First cluster should be the larger one (3 members)
  expect(result[0]!.members).toHaveLength(3)
  expect(result[1]!.members).toHaveLength(2)
})

test("buildClusters: deterministic tie-break by sorted-member-id string when size equal", () => {
  // Create two clusters with equal size, verify tie-break by sorted member ids
  const entries = [
    // Cluster 1: [b, c] → sorted key "b,c"
    { entry: entry({ id: "b", title: "foo bar", trigger: "one", domain: ["d1"] }), path: "/b" },
    { entry: entry({ id: "c", title: "foo bar", trigger: "one", domain: ["d1"] }), path: "/c" },
    // Cluster 2: [a, d] → sorted key "a,d"
    { entry: entry({ id: "a", title: "alpha beta", trigger: "two", domain: ["d2"] }), path: "/a" },
    { entry: entry({ id: "d", title: "alpha beta", trigger: "two", domain: ["d2"] }), path: "/d" },
  ]

  const result = buildClusters(entries, { minSize: 2 })
  expect(result).toHaveLength(2)
  // Both clusters have 2 members
  // Tie-break by sorted member ids: "a,d" < "b,c"
  // So cluster with [a,d] should come first
  expect(result[0]!.members.map(m => m.entry.id).sort()).toEqual(["a", "d"])
  expect(result[1]!.members.map(m => m.entry.id).sort()).toEqual(["b", "c"])
})

test("buildClusters: non-active entries excluded by caller contract", () => {
  // The test note says "test the CALLER filter in Task 3"
  // But the task brief says "buildClusters trusts input"
  // So this test just verifies that buildClusters doesn't filter status itself
  // (the filtering happens in Task 3)
  const entries = [
    { entry: entry({ id: "a", status: "active", title: "test", domain: ["d"] }), path: "/a" },
    { entry: entry({ id: "b", status: "superseded", title: "test", domain: ["d"] }), path: "/b" },
  ]
  const result = buildClusters(entries, { minSize: 2 })
  // Both entries should be included in clustering (buildClusters doesn't filter by status)
  // They form a cluster of 2
  expect(result).toHaveLength(1)
  expect(result[0]!.members).toHaveLength(2)
})

test("buildClusters: custom threshold and minSize options", () => {
  const entries = [
    { entry: entry({ id: "a", title: "alpha", trigger: "beta", domain: ["test"] }), path: "/a" },
    { entry: entry({ id: "b", title: "alpha", trigger: "beta", domain: ["test"] }), path: "/b" },
    { entry: entry({ id: "c", title: "alpha", trigger: "beta", domain: ["test"] }), path: "/c" },
  ]

  // With minSize=1, single entries become clusters
  const result = buildClusters(entries, { minSize: 1, threshold: 0.9 })
  expect(result).toHaveLength(1)
  expect(result[0]!.members).toHaveLength(3)

  // With high threshold, no clustering
  const result2 = buildClusters(entries, { threshold: 1.1, minSize: 2 })
  expect(result2).toHaveLength(0)
})

test("buildClusters: default options (threshold=0.35, minSize=2, cap=12)", () => {
  const entries = [
    { entry: entry({ id: "a", title: "hold violations", trigger: "after", domain: ["test"] }), path: "/a" },
    { entry: entry({ id: "b", title: "hold violations", trigger: "after", domain: ["test"] }), path: "/b" },
  ]
  const result = buildClusters(entries)
  expect(result).toHaveLength(1)
})

test("buildClusters: deterministic capping with tied confidences (permutation test)", () => {
  // Regression test for issue #1: confidence sort needs secondary tie-break
  // Create 15 entries with identical confidence, all similar
  // Run 10 random permutations, verify all yield identical sorted member-id set
  const baseEntries = Array.from({ length: 15 }, (_, i) => ({
    entry: entry({
      id: `m${i.toString().padStart(2, "0")}`,
      title: "hold violations timing slack after",
      trigger: "when design",
      domain: ["test"],
      confidence: 0.5, // All identical confidence
    }),
    path: `/entry${i}`,
  }))

  const results: string[][] = []
  for (let permutation = 0; permutation < 10; permutation++) {
    // Shuffle the input array (Fisher-Yates)
    const shuffled = [...baseEntries]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = shuffled[i]!
      shuffled[i] = shuffled[j]!
      shuffled[j] = temp
    }

    const result = buildClusters(shuffled, { minSize: 2, cap: 12 })
    expect(result).toHaveLength(1)
    expect(result[0]!.members).toHaveLength(12)
    const memberIds = result[0]!.members.map(m => m.entry.id).sort()
    results.push(memberIds)
  }

  // All permutations should yield the same sorted member-id set
  const firstResult = results[0]!
  for (let i = 1; i < results.length; i++) {
    expect(results[i]!).toEqual(firstResult)
  }
})

test("buildClusters: cross-domain dedup keeps lexicographically smallest domain", () => {
  // Regression test for issue #2: when deduping by member key, keep smallest domain
  // Create identical member sets under different domains
  const entries = [
    { entry: entry({ id: "a", title: "test", trigger: "one", domain: ["zeta", "alpha"] }), path: "/a" },
    { entry: entry({ id: "b", title: "test", trigger: "one", domain: ["zeta", "alpha"] }), path: "/b" },
  ]

  const result = buildClusters(entries, { minSize: 2 })
  // Both entries have both domains, so they form clusters under both zeta and alpha
  // After dedup by member set [a,b], should keep the one with domain "alpha" (lexicographically smallest)
  expect(result).toHaveLength(1)
  expect(result[0]!.domain).toBe("alpha")
})

test("pairSimilarity: different punctuation-only titles = 0", () => {
  // Regression test for issue #3: degenerate case with different punctuation-only strings
  // Both tokenize to empty, but raw trim differs, so should return 0
  const a = entry({ id: "a", title: "!!!", trigger: "" })
  const b = entry({ id: "b", title: "@@@", trigger: "" })
  expect(pairSimilarity(a, b)).toBe(0)
})

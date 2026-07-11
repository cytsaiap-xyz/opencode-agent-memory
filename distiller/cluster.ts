import type { MemoryEntry } from "./types"

/**
 * Tokenize a string using the same unicode-aware split as pool.ts.
 * Splits on anything that isn't a letter (\p{L}), number (\p{N}), or underscore.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
}

/**
 * Calculate Jaccard similarity (overlap / union) of two token sets.
 * Reuses the degenerate-empty-set rule from pool.ts titleJaccard:
 * Both empty → 1 only if raw trims are identical, else 0.
 * Returns a number in [0, 1].
 */
function tokenSetJaccard(a: string, b: string): number {
  const tokensA = new Set(tokenize(a))
  const tokensB = new Set(tokenize(b))

  if (tokensA.size === 0 && tokensB.size === 0) {
    // both empty: return 1 only if raw strings are identical after trim
    return a.trim() === b.trim() ? 1 : 0
  }
  if (tokensA.size === 0 || tokensB.size === 0) return 0 // one empty, one not

  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }

  const union = tokensA.size + tokensB.size - intersection
  return intersection / union
}

/**
 * Compute pairwise similarity between two memory entries.
 * Uses token-set Jaccard over the combined string: `${entry.title} ${entry.trigger}`
 */
export function pairSimilarity(a: MemoryEntry, b: MemoryEntry): number {
  const combined_a = `${a.title} ${a.trigger}`
  const combined_b = `${b.title} ${b.trigger}`
  return tokenSetJaccard(combined_a, combined_b)
}

/**
 * A cluster of related memory entries under a specific domain.
 */
export interface Cluster {
  domain: string
  members: Array<{ entry: MemoryEntry; path: string }>
}

/**
 * Union-Find (Disjoint Set Union) implementation for clustering.
 */
class UnionFind {
  parent: Map<string, string> = new Map()
  rank: Map<string, number> = new Map()

  makeSet(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id)
      this.rank.set(id, 0)
    }
  }

  find(id: string): string {
    if (!this.parent.has(id)) this.makeSet(id)
    const p = this.parent.get(id)!
    if (p !== id) {
      this.parent.set(id, this.find(p))
    }
    return this.parent.get(id)!
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return

    const rankA = this.rank.get(rootA) || 0
    const rankB = this.rank.get(rootB) || 0

    if (rankA < rankB) {
      this.parent.set(rootA, rootB)
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA)
    } else {
      this.parent.set(rootB, rootA)
      this.rank.set(rootA, rankA + 1)
    }
  }

  getComponents(): Map<string, Set<string>> {
    const components = new Map<string, Set<string>>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      if (!components.has(root)) {
        components.set(root, new Set())
      }
      components.get(root)!.add(id)
    }
    return components
  }
}

/**
 * Build deterministic clusters from memory entries.
 *
 * Algorithm:
 * 1. Group entries by each domain tag (multi-domain entries appear in multiple groups)
 * 2. Within each group: union-find on pairwise similarity ≥ threshold
 * 3. Extract components with ≥ minSize members → form clusters
 * 4. Cap clusters at cap members (keep highest-confidence)
 * 5. Dedupe clusters across domains by sorted member-id key
 * 6. Output sorted largest-first, tie-break by sorted-member-id string
 */
export function buildClusters(
  entries: Array<{ entry: MemoryEntry; path: string }>,
  opts?: { threshold?: number; minSize?: number; cap?: number },
): Cluster[] {
  const threshold = opts?.threshold ?? 0.35
  const minSize = opts?.minSize ?? 2
  const cap = opts?.cap ?? 12

  if (entries.length === 0) return []

  // Step 1: Build domain → entries map
  const domainToEntries = new Map<string, Array<{ entry: MemoryEntry; path: string }>>()
  for (const item of entries) {
    for (const domain of item.entry.domain) {
      if (!domainToEntries.has(domain)) {
        domainToEntries.set(domain, [])
      }
      domainToEntries.get(domain)!.push(item)
    }
  }

  // Step 2 & 3: Cluster within each domain using union-find
  const clustersByDomain = new Map<string, Cluster[]>()
  for (const [domain, domainEntries] of domainToEntries) {
    const uf = new UnionFind()

    // Initialize union-find with all entry ids
    for (const item of domainEntries) {
      uf.makeSet(item.entry.id)
    }

    // Compute pairwise similarities and union similar pairs
    for (let i = 0; i < domainEntries.length; i++) {
      for (let j = i + 1; j < domainEntries.length; j++) {
        const sim = pairSimilarity(domainEntries[i]!.entry, domainEntries[j]!.entry)
        if (sim >= threshold) {
          uf.union(domainEntries[i]!.entry.id, domainEntries[j]!.entry.id)
        }
      }
    }

    // Extract components and build clusters
    const components = uf.getComponents()
    const clusters: Cluster[] = []

    for (const componentIds of components.values()) {
      if (componentIds.size >= minSize) {
        // Collect members for this component
        let members = domainEntries.filter(item => componentIds.has(item.entry.id))

        // Step 4: Cap at cap members, keeping highest-confidence
        if (members.length > cap) {
          members = members
            .sort((a, b) => b.entry.confidence - a.entry.confidence)
            .slice(0, cap)
        }

        clusters.push({
          domain,
          members,
        })
      }
    }

    if (clusters.length > 0) {
      clustersByDomain.set(domain, clusters)
    }
  }

  // Step 5: Dedupe clusters across domains by sorted member-id key
  const clustersByMemberKey = new Map<string, Cluster>()
  for (const clusters of clustersByDomain.values()) {
    for (const cluster of clusters) {
      const memberIds = cluster.members.map(m => m.entry.id).sort()
      const key = memberIds.join(",")

      // Keep the first cluster with this member set (deterministic by domain processing order)
      if (!clustersByMemberKey.has(key)) {
        clustersByMemberKey.set(key, cluster)
      }
    }
  }

  // Step 6: Sort output largest-first, tie-break by sorted-member-id string
  const result = Array.from(clustersByMemberKey.values())
  result.sort((a, b) => {
    // Largest first (descending)
    if (a.members.length !== b.members.length) {
      return b.members.length - a.members.length
    }
    // Tie-break by sorted member ids
    const keyA = a.members.map(m => m.entry.id).sort().join(",")
    const keyB = b.members.map(m => m.entry.id).sort().join(",")
    return keyA.localeCompare(keyB)
  })

  return result
}

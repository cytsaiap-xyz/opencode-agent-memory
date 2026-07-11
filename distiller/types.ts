export type MemoryType = "decision" | "root_cause" | "pitfall" | "know_how" | "convention" | "workflow"
export type MemoryClass = "episodic" | "semantic" | "procedural"
export type MemoryStatus = "candidate" | "active" | "superseded" | "quarantined" | "archived"
export type ReviewState = "auto" | "human_pending" | "human_approved"
export interface EvidenceRef { session: string; anchors: string[]; observed_at: string }
export interface MemoryEntry {
  id: string; memory_class: MemoryClass; type: MemoryType
  title: string; trigger: string; project: string; scope: "project" | "global"
  domain: string[]; volatile: boolean; confidence: number
  status: MemoryStatus; superseded_by: string | null; supersedes: string | null; promoted_from: string | null; review: ReviewState
  evidence: EvidenceRef[]
  provenance: { extractor: string; prompt_hash: string }
  created_at: string; updated_at: string
  lesson: string; notes: string[]
}
export const PIPELINE_VERSION = "1"

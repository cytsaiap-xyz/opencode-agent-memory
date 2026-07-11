import { describe, it, expect } from "bun:test"
import type { Candidate } from "../distiller/extract"
import { candidateMatches, scoreCase, type ExtractionCase } from "./match"

describe("candidateMatches", () => {
  it("matches keywords case-insensitively", () => {
    const candidate: Candidate = {
      type: "decision",
      title: "Useful Skew Setup",
      trigger: "When timing fails",
      lesson: "Apply skew to critical paths",
      domain: ["timing"],
      evidence: [{ message_id: "msg_1" }],
      salience: 8,
      volatile: false,
    }

    const rule = { keywords: ["useful", "skew"] }
    expect(candidateMatches(candidate, rule)).toBe(true)

    const rule2 = { keywords: ["USEFUL", "SKEW"] }
    expect(candidateMatches(candidate, rule2)).toBe(true)

    const rule3 = { keywords: ["UsEfUl", "sKeW"] }
    expect(candidateMatches(candidate, rule3)).toBe(true)
  })

  it("requires ALL keywords to be present", () => {
    const candidate: Candidate = {
      type: "know_how",
      title: "Retiming Flow",
      trigger: "Setup timing closure",
      lesson: "Run retiming before LVT swap",
      domain: ["timing"],
      evidence: [{ message_id: "msg_2" }],
      salience: 7,
      volatile: false,
    }

    expect(candidateMatches(candidate, { keywords: ["retiming"] })).toBe(true)
    expect(candidateMatches(candidate, { keywords: ["retiming", "setup"] })).toBe(true)
    expect(candidateMatches(candidate, { keywords: ["retiming", "xyz"] })).toBe(false)
  })

  it("filters by type when specified", () => {
    const candidate: Candidate = {
      type: "decision",
      title: "Use Decimal for Money",
      trigger: "Handle currency",
      lesson: "Never use float for money",
      domain: ["coding"],
      evidence: [{ message_id: "msg_3" }],
      salience: 9,
      volatile: false,
    }

    expect(candidateMatches(candidate, { type: "decision", keywords: ["decimal"] })).toBe(true)
    expect(candidateMatches(candidate, { type: "pitfall", keywords: ["decimal"] })).toBe(false)
    expect(candidateMatches(candidate, { keywords: ["decimal"] })).toBe(true)
  })

  it("filters by a type SET when type is an array — matches any member", () => {
    const candidate: Candidate = {
      type: "decision",
      title: "Use Decimal for Money",
      trigger: "Handle currency",
      lesson: "Never use float for money",
      domain: ["coding"],
      evidence: [{ message_id: "msg_3" }],
      salience: 9,
      volatile: false,
    }

    // array with a match (candidate.type "decision" is a member of the set)
    expect(candidateMatches(candidate, { type: ["decision", "convention"], keywords: ["decimal"] })).toBe(true)
    // array without a match (candidate.type "decision" is not a member of the set)
    expect(candidateMatches(candidate, { type: ["pitfall", "root_cause"], keywords: ["decimal"] })).toBe(false)
    // plain string behavior unchanged when type is a scalar
    expect(candidateMatches(candidate, { type: "decision", keywords: ["decimal"] })).toBe(true)
    expect(candidateMatches(candidate, { type: "pitfall", keywords: ["decimal"] })).toBe(false)
  })

  it("searches across title, trigger, and lesson", () => {
    const candidate: Candidate = {
      type: "know_how",
      title: "Timing Analysis",
      trigger: "When synthesis fails with retiming errors",
      lesson: "Apply incremental retiming for convergence",
      domain: ["timing"],
      evidence: [{ message_id: "msg_4" }],
      salience: 6,
      volatile: false,
    }

    expect(candidateMatches(candidate, { keywords: ["timing"] })).toBe(true)
    expect(candidateMatches(candidate, { keywords: ["retiming"] })).toBe(true)
    expect(candidateMatches(candidate, { keywords: ["convergence"] })).toBe(true)
  })
})

describe("scoreCase", () => {
  it("passes when all expectations are met", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["decision"] }],
      forbid: [],
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Decision example",
        trigger: "When needed",
        lesson: "Make a decision",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.fixture).toBe("test.md")
    expect(score.status).toBe("pass")
    expect(score.expectationsMet).toBe(1)
    expect(score.expectationsTotal).toBe(1)
    expect(score.forbiddenHits).toEqual([])
    expect(score.extras).toBe(0)
    expect(score.failures).toEqual([])
  })

  it("fails when expectation is not met", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["nonexistent"] }],
      forbid: [],
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Something else",
        trigger: "When needed",
        lesson: "Make a decision",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("fail")
    expect(score.expectationsMet).toBe(0)
    expect(score.expectationsTotal).toBe(1)
    expect(score.failures.length).toBeGreaterThan(0)
    expect(score.failures[0]).toMatch(/expect\[0\]/)
    expect(score.failures[0]).toMatch(/nonexistent/)
    expect(score.failures[0]).toMatch(/matched 0/)
  })

  it("respects min count requirement", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["timing"], min: 2 }],
      forbid: [],
    }

    const candidates: Candidate[] = [
      {
        type: "know_how",
        title: "Timing stuff",
        trigger: "When timing fails",
        lesson: "Fix timing",
        domain: ["timing"],
        evidence: [{ message_id: "msg_1" }],
        salience: 7,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("fail")
    expect(score.expectationsMet).toBe(0)
    expect(score.failures.length).toBeGreaterThan(0)
    expect(score.failures[0]).toMatch(/matched 1 < 2/)
  })

  it("requires min count of candidates", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["timing"], min: 2 }],
      forbid: [],
    }

    const candidates: Candidate[] = [
      {
        type: "know_how",
        title: "Timing approach 1",
        trigger: "Setup timing",
        lesson: "Do timing first",
        domain: ["timing"],
        evidence: [{ message_id: "msg_1" }],
        salience: 7,
        volatile: false,
      },
      {
        type: "decision",
        title: "Timing decision",
        trigger: "When timing fails",
        lesson: "Use incremental timing",
        domain: ["timing"],
        evidence: [{ message_id: "msg_2" }],
        salience: 8,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("pass")
    expect(score.expectationsMet).toBe(1)
    expect(score.failures).toEqual([])
  })

  it("records forbidden hits with human-readable reasons", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["good"] }],
      forbid: [{ keywords: ["bad"] }],
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Good decision",
        trigger: "When needed",
        lesson: "Make good choices",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
      {
        type: "pitfall",
        title: "Bad pitfall",
        trigger: "When bad happens",
        lesson: "Avoid bad things",
        domain: ["test"],
        evidence: [{ message_id: "msg_2" }],
        salience: 7,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("fail")
    expect(score.forbiddenHits.length).toBe(1)
    const forbidHit = score.forbiddenHits[0]!
    expect(forbidHit).toMatch(/matched forbid/)
    expect(forbidHit).toMatch(/bad/)
    expect(forbidHit).toMatch(/Bad pitfall/)
    expect(score.failures).toContain(forbidHit)
  })

  it("counts extras as candidates matching NO expect rule", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["expected"] }],
      forbid: [],
    }

    const candidates: Candidate[] = [
      {
        type: "know_how",
        title: "Expected thing",
        trigger: "Setup",
        lesson: "This matches expected",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
      {
        type: "decision",
        title: "Extra thing 1",
        trigger: "When needed",
        lesson: "This is extra",
        domain: ["test"],
        evidence: [{ message_id: "msg_2" }],
        salience: 7,
        volatile: false,
      },
      {
        type: "pitfall",
        title: "Extra thing 2",
        trigger: "When bad",
        lesson: "Another extra one",
        domain: ["test"],
        evidence: [{ message_id: "msg_3" }],
        salience: 6,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("pass")
    expect(score.extras).toBe(2)
    expect(score.expectationsMet).toBe(1)
  })

  it("respects max_extra constraint", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["expected"] }],
      forbid: [],
      max_extra: 1,
    }

    const candidates: Candidate[] = [
      {
        type: "know_how",
        title: "Expected",
        trigger: "Setup",
        lesson: "Expected thing",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 8,
        volatile: false,
      },
      {
        type: "decision",
        title: "Extra 1",
        trigger: "When",
        lesson: "Extra",
        domain: ["test"],
        evidence: [{ message_id: "msg_2" }],
        salience: 7,
        volatile: false,
      },
      {
        type: "pitfall",
        title: "Extra 2",
        trigger: "When bad",
        lesson: "Extra",
        domain: ["test"],
        evidence: [{ message_id: "msg_3" }],
        salience: 6,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("fail")
    expect(score.extras).toBe(2)
    expect(score.failures.length).toBeGreaterThan(0)
    expect(score.failures[0]).toMatch(/extras/)
    expect(score.failures[0]).toMatch(/2.*>.*1/)
  })

  it("max_total 0 passes on empty candidates", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [],
      forbid: [],
      max_total: 0,
    }

    const candidates: Candidate[] = []

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("pass")
    expect(score.extras).toBe(0)
    expect(score.failures).toEqual([])
  })

  it("max_total 0 fails on 1 candidate", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [],
      forbid: [],
      max_total: 0,
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Any candidate",
        trigger: "Triggers",
        lesson: "Any lesson",
        domain: ["test"],
        evidence: [{ message_id: "msg_1" }],
        salience: 5,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("fail")
    expect(score.failures.length).toBeGreaterThan(0)
    expect(score.failures[0]).toMatch(/total/)
    expect(score.failures[0]).toMatch(/1.*>.*0/)
  })

  it("fully passing PPA-like case", () => {
    const kase: ExtractionCase = {
      fixture: "ppa-timing-closure.md",
      expect: [
        { type: "decision", keywords: ["useful", "skew"] },
        { type: "pitfall", keywords: ["synthesis"] },
        { keywords: ["retiming"] },
      ],
      forbid: [
        { keywords: ["lunch"] },
        { keywords: ["joke"] },
      ],
      max_extra: 8,
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Useful skew setup timing",
        trigger: "When setup timing fails",
        lesson: "Apply useful skew to critical paths before LVT swap",
        domain: ["timing-closure"],
        evidence: [{ message_id: "msg_1" }],
        salience: 9,
        volatile: false,
      },
      {
        type: "pitfall",
        title: "Synthesis vs PnR timing gap",
        trigger: "When synthesis shows green but PnR fails",
        lesson: "Timing assumptions in synthesis diverge from PnR; verify with incremental PnR timing",
        domain: ["timing-closure"],
        evidence: [{ message_id: "msg_2" }],
        salience: 8,
        volatile: false,
      },
      {
        type: "know_how",
        title: "Retiming flow for timing closure",
        trigger: "When timing closure requires slack redistribution",
        lesson: "Run incremental retiming before hold-time fixes and LVT swaps",
        domain: ["timing-closure"],
        evidence: [{ message_id: "msg_3" }],
        salience: 7,
        volatile: false,
      },
      {
        type: "decision",
        title: "Clock frequency override",
        trigger: "When tool default disagrees with design spec",
        lesson: "Set clock frequency explicitly in constraints before synthesis",
        domain: ["timing-closure"],
        evidence: [{ message_id: "msg_4" }],
        salience: 6,
        volatile: false,
      },
      {
        type: "know_how",
        title: "Hold timing fix strategy",
        trigger: "When hold time violations appear in PnR",
        lesson: "Fix hold violations in slow corner first, then check setup in fast corner",
        domain: ["timing-closure"],
        evidence: [{ message_id: "msg_5" }],
        salience: 6,
        volatile: false,
      },
    ]

    const score = scoreCase(kase, candidates)
    expect(score.fixture).toBe("ppa-timing-closure.md")
    expect(score.status).toBe("pass")
    expect(score.expectationsMet).toBe(3)
    expect(score.expectationsTotal).toBe(3)
    expect(score.forbiddenHits).toEqual([])
    expect(score.extras).toBe(2)
    expect(score.failures).toEqual([])
  })

  it("defaults: max_extra and max_total to Infinity", () => {
    const kase: ExtractionCase = {
      fixture: "test.md",
      expect: [{ keywords: ["sought"] }],
      forbid: [],
      // max_extra and max_total not specified, should default to Infinity
    }

    const candidates: Candidate[] = [
      {
        type: "decision",
        title: "Sought item",
        trigger: "T",
        lesson: "L",
        domain: ["test"],
        evidence: [{ message_id: "m1" }],
        salience: 5,
        volatile: false,
      },
      ...Array.from({ length: 100 }, (_, i) => ({
        type: "know_how" as const,
        title: `Item ${i}`,
        trigger: "T",
        lesson: "L",
        domain: ["test"],
        evidence: [{ message_id: `m${i + 2}` }],
        salience: 5,
        volatile: false,
      })),
    ]

    const score = scoreCase(kase, candidates)
    expect(score.status).toBe("pass")
    expect(score.extras).toBe(100)
    expect(score.failures).toEqual([])
  })
})

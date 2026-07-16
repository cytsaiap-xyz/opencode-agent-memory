import { expect, test } from "bun:test"
import { Semaphore, withConcurrencyLimit } from "./limiter"
import type { LlmClient, LlmRequest } from "./llm"

// ============ Semaphore constructor tests ============

test("Semaphore: rejects invalid limit (negative)", () => {
  expect(() => new Semaphore(-1)).toThrow("positive integer")
})

test("Semaphore: rejects invalid limit (zero)", () => {
  expect(() => new Semaphore(0)).toThrow("positive integer")
})

test("Semaphore: rejects invalid limit (non-integer)", () => {
  expect(() => new Semaphore(1.5)).toThrow("positive integer")
})

test("Semaphore: accepts valid limit of 1", () => {
  expect(() => new Semaphore(1)).not.toThrow()
})

test("Semaphore: accepts valid limit of 3", () => {
  expect(() => new Semaphore(3)).not.toThrow()
})

// ============ Semaphore acquire/release tests ============

test("Semaphore: acquire resolves immediately when under limit", async () => {
  const sem = new Semaphore(2)
  const release1 = await sem.acquire()
  expect(typeof release1).toBe("function")
  const release2 = await sem.acquire()
  expect(typeof release2).toBe("function")
  release1()
  release2()
})

test("Semaphore: double-release is a no-op", async () => {
  const sem = new Semaphore(1)
  const release = await sem.acquire()
  release()
  release() // should not throw or cause issues
  // If there was a bug (e.g., decrementing twice), this would break the next acquire
  const release2 = await sem.acquire()
  expect(typeof release2).toBe("function")
  release2()
})

test("Semaphore: acquire blocks when at limit", async () => {
  const sem = new Semaphore(1)
  const release1 = await sem.acquire()

  let release2Called = false
  const p = sem.acquire().then((release) => {
    release2Called = true
    return release
  })

  // Give the promise time to settle (it shouldn't)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(release2Called).toBe(false)

  // Release the first permit
  release1()

  // Now the second acquire should complete
  const release2 = await p
  expect(release2Called).toBe(true)
  release2()
})

test("Semaphore: FIFO ordering of waiters", async () => {
  const sem = new Semaphore(1)
  const release1 = await sem.acquire()

  const order: number[] = []
  const p1 = sem.acquire().then((release) => {
    order.push(1)
    return release
  })
  const p2 = sem.acquire().then((release) => {
    order.push(2)
    return release
  })
  const p3 = sem.acquire().then((release) => {
    order.push(3)
    return release
  })

  release1()
  const r1 = await p1
  r1()

  const r2 = await p2
  r2()

  const r3 = await p3
  r3()

  expect(order).toEqual([1, 2, 3])
})

// ============ Gate-controlled FakeLlm for concurrency testing ============

class GatedFakeLlm implements LlmClient {
  private callCount: number = 0
  private concurrent: number = 0
  private maxConcurrent: number = 0
  private resolvers: Map<number, (value: string) => void> = new Map()
  private rejecters: Map<number, (err: Error) => void> = new Map()

  describe(): string {
    return "gated-fake"
  }

  async complete(req: LlmRequest): Promise<string> {
    const callIndex = this.callCount++
    this.concurrent++
    if (this.concurrent > this.maxConcurrent) {
      this.maxConcurrent = this.concurrent
    }

    return new Promise<string>((resolve, reject) => {
      this.resolvers.set(callIndex, (value: string) => {
        this.concurrent--
        resolve(value)
      })
      this.rejecters.set(callIndex, (err: Error) => {
        this.concurrent--
        reject(err)
      })
    })
  }

  resolveCall(index: number, value: string = `result-${index}`) {
    const resolver = this.resolvers.get(index)
    if (resolver) {
      resolver(value)
      this.resolvers.delete(index)
      this.rejecters.delete(index)
    }
  }

  rejectCall(index: number, error: string) {
    const rejecter = this.rejecters.get(index)
    if (rejecter) {
      rejecter(new Error(error))
      this.resolvers.delete(index)
      this.rejecters.delete(index)
    }
  }

  getCallCount(): number {
    return this.callCount
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  getPendingCount(): number {
    return this.resolvers.size
  }
}

// ============ withConcurrencyLimit tests ============

test("withConcurrencyLimit: max in-flight never exceeds limit with 10 queued calls and limit 3", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 3)

  // Start 10 calls concurrently
  const promises: Promise<string>[] = []
  for (let i = 0; i < 10; i++) {
    promises.push(llm.complete({ prompt: `prompt-${i}` }))
  }

  // Give the first batch of calls time to reach inner LLM (should be 3)
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Max should be 3 at this point
  expect(innerLlm.getMaxConcurrent()).toBeLessThanOrEqual(3)

  // Resolve calls one at a time, allowing the semaphore to feed more calls
  for (let i = 0; i < 10; i++) {
    innerLlm.resolveCall(i)
    // Give time for the next call to enter
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Max should never exceed 3
    expect(innerLlm.getMaxConcurrent()).toBeLessThanOrEqual(3)
  }

  const results = await Promise.all(promises)
  expect(results.length).toBe(10)
})

test("withConcurrencyLimit: FIFO completion order", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 2)

  const order: number[] = []
  const promises: Promise<string>[] = []

  for (let i = 0; i < 4; i++) {
    promises.push(
      llm.complete({ prompt: `prompt-${i}` }).then((result) => {
        order.push(i)
        return result
      }),
    )
  }

  // Give calls time to queue up
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Resolve calls in FIFO order (0, 1, 2, 3)
  for (let i = 0; i < 4; i++) {
    innerLlm.resolveCall(i)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  await Promise.all(promises)
  expect(order).toEqual([0, 1, 2, 3])
})

test("withConcurrencyLimit: permit released when complete() throws", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 1)

  const results: (string | Error)[] = []
  const promises: Promise<string | Error>[] = []

  // First call succeeds
  promises.push(
    llm.complete({ prompt: "p1" }).then((r) => {
      results.push(r)
      return r
    }),
  )

  // Second call will fail
  promises.push(
    llm
      .complete({ prompt: "p2" })
      .catch((e) => {
        results.push(e as Error)
        return e as Error
      }),
  )

  // Third call should proceed after second fails
  promises.push(
    llm.complete({ prompt: "p3" }).then((r) => {
      results.push(r)
      return r
    }),
  )

  // Wait for all 3 to be queued
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Resolve first call
  innerLlm.resolveCall(0, "result-0")
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Reject second call (should release permit for third)
  innerLlm.rejectCall(1, "error in call 1")
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Resolve third call
  innerLlm.resolveCall(2, "result-2")

  await Promise.all(promises)

  expect(results.length).toBe(3)
  expect(results[0]).toBe("result-0")
  expect(results[1]).toBeInstanceOf(Error)
  expect(results[2]).toBe("result-2")
})

test("withConcurrencyLimit: limit=1 fully serializes", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 1)

  const callOrder: number[] = []
  const promises: Promise<string>[] = []

  for (let i = 0; i < 5; i++) {
    promises.push(
      llm.complete({ prompt: `prompt-${i}` }).then((result) => {
        callOrder.push(i)
        return result
      }),
    )
  }

  // Give calls time to queue
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Max concurrent should be 1
  expect(innerLlm.getMaxConcurrent()).toBe(1)

  // Resolve calls in order
  for (let i = 0; i < 5; i++) {
    innerLlm.resolveCall(i)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  await Promise.all(promises)
  expect(callOrder).toEqual([0, 1, 2, 3, 4])
})

test("withConcurrencyLimit: describe() passthrough", async () => {
  const innerLlm: LlmClient = {
    describe: () => "custom-llm-description",
    complete: async () => "response",
  }
  const llm = withConcurrencyLimit(innerLlm, 2)
  expect(llm.describe()).toBe("custom-llm-description")
})

test("withConcurrencyLimit: describe() works with GatedFakeLlm", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 2)
  expect(llm.describe()).toBe("gated-fake")
})

test("withConcurrencyLimit: all calls complete successfully", async () => {
  const innerLlm = new GatedFakeLlm()
  const llm = withConcurrencyLimit(innerLlm, 2)

  const promises: Promise<string>[] = []
  for (let i = 0; i < 4; i++) {
    promises.push(llm.complete({ prompt: `prompt-${i}` }))
  }

  // Wait for calls to queue
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Resolve all calls
  for (let i = 0; i < 4; i++) {
    innerLlm.resolveCall(i, `result-${i}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const results = await Promise.all(promises)
  expect(results).toEqual(["result-0", "result-1", "result-2", "result-3"])
})

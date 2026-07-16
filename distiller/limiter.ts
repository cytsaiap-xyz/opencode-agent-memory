import type { LlmClient, LlmRequest } from "./llm"

export class Semaphore {
  private limit: number
  private inFlight: number = 0
  private waiters: Array<{
    resolve: (release: () => void) => void
  }> = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`)
    }
    this.limit = limit
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.limit) {
      this.inFlight++
      return this.createRelease()
    }

    return new Promise((resolve) => {
      this.waiters.push({ resolve })
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true

      this.inFlight--
      const waiter = this.waiters.shift()
      if (waiter) {
        this.inFlight++
        waiter.resolve(this.createRelease())
      }
    }
  }
}

export function withConcurrencyLimit(
  llm: LlmClient,
  limit: number,
): LlmClient {
  const semaphore = new Semaphore(limit)

  return {
    describe: () => llm.describe(),
    async complete(req: LlmRequest): Promise<string> {
      const release = await semaphore.acquire()
      try {
        return await llm.complete(req)
      } finally {
        release()
      }
    },
  }
}

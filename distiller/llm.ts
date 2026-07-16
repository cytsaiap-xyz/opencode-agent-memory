export interface LlmRequest { system?: string; prompt: string; schema?: Record<string, unknown> }
export interface LlmClient { complete(req: LlmRequest): Promise<string>; describe(): string }

// A per-call LLM timeout guards against a hung vLLM fetch or opencode-run subprocess stalling
// a `complete()` call forever — which would pin a `withConcurrencyLimit` permit for good and,
// worse, leave the nightly `distill run` never finishing, so the NEXT scheduled run starts
// concurrently against the same store (a cross-process double-writer). A timeout throws a
// plain Error (`llm call timed out after <ms>ms`), so it's absorbed by the exact same
// fail-open/tolerate paths as any other LLM error: an EXTRACT run is tolerated, a JUDGE call
// abstains, TRIAGE fails open. AGENT_MEMORY_LLM_TIMEOUT_MS (validated in parseTimeoutMs below)
// governs this; clientFromEnv reads it once so every creation path gets it uniformly.
export const DEFAULT_LLM_TIMEOUT_MS = 600_000

function timeoutError(ms: number): Error {
  return new Error(`llm call timed out after ${ms}ms`)
}

export function createVllmClient(cfg: {
  url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number
}): LlmClient {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    describe: () => `vllm/${cfg.model}`,
    async complete(req) {
      const messages: Array<{ role: string; content: string }> = []
      if (req.system) messages.push({ role: "system", content: req.system })
      messages.push({ role: "user", content: req.prompt })
      const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0 }
      if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "output", schema: req.schema } }
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`

      const controller = new AbortController()
      const fetchPromise = doFetch(`${cfg.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      })

      let res: Response
      if (cfg.timeoutMs === undefined) {
        res = await fetchPromise
      } else {
        const ms = cfg.timeoutMs
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(timeoutError(ms))
          }, ms)
          timer.unref?.()
        })
        // Never leave the raced-away input promise unsubscribed: if the timer wins, fetchPromise
        // may still settle (reject) later once the abort propagates — a noop catch keeps that
        // from surfacing as an unhandled rejection.
        fetchPromise.catch(() => {})
        try {
          res = await Promise.race([fetchPromise, timeoutPromise])
        } finally {
          clearTimeout(timer)
        }
      }

      const text = await res.text()
      if (!res.ok) throw new Error(`vllm request failed: ${res.status} ${text.slice(0, 300)}`)
      let content: unknown
      try {
        content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      } catch {
        throw new Error(`vllm returned non-JSON body: ${text.slice(0, 300)}`)
      }
      if (typeof content !== "string" || !content) throw new Error(`vllm response missing message content: ${text.slice(0, 300)}`)
      return content
    },
  }
}

export type SpawnResult = { exitCode: number; stdout: string; stderr: string }
// `signal` is optional so existing test doubles (single-arg `(argv) => ...`) keep working
// unmodified — only the real `bunSpawn` below actually honors it (to kill the real
// subprocess on timeout); a fake that ignores it is still caught by createOpencodeRunClient's
// own outer race against the timeout below.
export type SpawnFn = (argv: string[], signal?: AbortSignal) => Promise<SpawnResult>

const bunSpawn: SpawnFn = async (argv, signal) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  if (signal) {
    if (signal.aborted) proc.kill()
    else signal.addEventListener("abort", () => proc.kill(), { once: true })
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function createOpencodeRunClient(opts: { spawn?: SpawnFn; timeoutMs?: number } = {}): LlmClient {
  const spawn = opts.spawn ?? bunSpawn
  return {
    describe: () => "opencode-run",
    async complete(req) {
      let message = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt
      if (req.schema)
        message += `\n\nReply with ONLY JSON matching this schema — no prose, no code fences:\n${JSON.stringify(req.schema, null, 2)}`
      // Message argument MUST come before flags: `opencode run` declares -f/--file
      // etc. as yargs array flags that greedily swallow following positionals.
      const argv = ["opencode", "run", message, "--pure", "--title", "distiller"]

      const controller = new AbortController()
      const spawnPromise = spawn(argv, controller.signal)

      let res: SpawnResult
      if (opts.timeoutMs === undefined) {
        res = await spawnPromise
      } else {
        const ms = opts.timeoutMs
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort() // real bunSpawn kills the subprocess on this signal
            reject(timeoutError(ms))
          }, ms)
          timer.unref?.()
        })
        // Never leave the raced-away spawn promise unsubscribed (see createVllmClient above).
        spawnPromise.catch(() => {})
        try {
          res = await Promise.race([spawnPromise, timeoutPromise])
        } finally {
          clearTimeout(timer)
        }
      }

      if (res.exitCode !== 0) throw new Error(`opencode run failed (exit ${res.exitCode}): ${res.stderr.slice(-300)}`)
      return res.stdout.trim()
    },
  }
}

// Validated at every client-creation entry point (see clientFromEnv below), the same "friendly
// error, no silent fallback" contract as the other AGENT_MEMORY_* envs.
export function parseTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.AGENT_MEMORY_LLM_TIMEOUT_MS
  if (raw === undefined || raw === "") return DEFAULT_LLM_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1000) {
    throw new Error(`AGENT_MEMORY_LLM_TIMEOUT_MS must be a valid number (got "${raw}")`)
  }
  return n
}

export function clientFromEnv(env: Record<string, string | undefined> = process.env): LlmClient {
  const timeoutMs = parseTimeoutMs(env)
  if (env.AGENT_MEMORY_LLM === "vllm") {
    const url = env.AGENT_MEMORY_VLLM_URL
    const model = env.AGENT_MEMORY_VLLM_MODEL
    if (!url) throw new Error("AGENT_MEMORY_VLLM_URL is required when AGENT_MEMORY_LLM=vllm")
    if (!model) throw new Error("AGENT_MEMORY_VLLM_MODEL is required when AGENT_MEMORY_LLM=vllm")
    return createVllmClient({ url, model, apiKey: env.AGENT_MEMORY_VLLM_KEY, timeoutMs })
  }
  return createOpencodeRunClient({ timeoutMs })
}

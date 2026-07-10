export interface LlmRequest { system?: string; prompt: string; schema?: Record<string, unknown> }
export interface LlmClient { complete(req: LlmRequest): Promise<string>; describe(): string }

export function createVllmClient(cfg: {
  url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch
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
      const res = await doFetch(`${cfg.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body),
      })
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
export type SpawnFn = (argv: string[]) => Promise<SpawnResult>

const bunSpawn: SpawnFn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function createOpencodeRunClient(opts: { spawn?: SpawnFn } = {}): LlmClient {
  const spawn = opts.spawn ?? bunSpawn
  return {
    describe: () => "opencode-run",
    async complete(req) {
      let message = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt
      if (req.schema)
        message += `\n\nReply with ONLY JSON matching this schema — no prose, no code fences:\n${JSON.stringify(req.schema, null, 2)}`
      // Message argument MUST come before flags: `opencode run` declares -f/--file
      // etc. as yargs array flags that greedily swallow following positionals.
      const res = await spawn(["opencode", "run", message, "--pure", "--title", "distiller"])
      if (res.exitCode !== 0) throw new Error(`opencode run failed (exit ${res.exitCode}): ${res.stderr.slice(-300)}`)
      return res.stdout.trim()
    },
  }
}

export function clientFromEnv(env: Record<string, string | undefined> = process.env): LlmClient {
  if (env.AGENT_MEMORY_LLM === "vllm") {
    const url = env.AGENT_MEMORY_VLLM_URL
    const model = env.AGENT_MEMORY_VLLM_MODEL
    if (!url) throw new Error("AGENT_MEMORY_VLLM_URL is required when AGENT_MEMORY_LLM=vllm")
    if (!model) throw new Error("AGENT_MEMORY_VLLM_MODEL is required when AGENT_MEMORY_LLM=vllm")
    return createVllmClient({ url, model, apiKey: env.AGENT_MEMORY_VLLM_KEY })
  }
  return createOpencodeRunClient()
}

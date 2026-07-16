import { expect, test } from "bun:test"
import { clientFromEnv, createOpencodeRunClient, createVllmClient } from "./llm"

test("vllm client posts OpenAI-compatible request and returns content", async () => {
  const seen: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {}
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.body = JSON.parse(String(init?.body))
    seen.auth = new Headers(init?.headers).get("authorization")
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
  }) as unknown as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "qwen3", apiKey: "k1", fetchImpl })
  const out = await client.complete({ system: "sys", prompt: "hi", schema: { type: "object" } })
  expect(out).toBe('{"ok":true}')
  expect(seen.url).toBe("http://v:8000/v1/chat/completions")
  expect(seen.auth).toBe("Bearer k1")
  const body = seen.body as Record<string, unknown>
  expect(body.model).toBe("qwen3")
  expect(body.temperature).toBe(0)
  expect((body.messages as unknown[]).length).toBe(2)
  expect((body.response_format as { type: string }).type).toBe("json_schema")
  expect(client.describe()).toBe("vllm/qwen3")
})

test("vllm client throws with status and body snippet on non-2xx", async () => {
  const fetchImpl = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "x", fetchImpl })
  await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/404.*model not found/s)
})

test("opencode-run client puts message before flags and joins system+prompt", async () => {
  let argv: string[] = []
  const client = createOpencodeRunClient({
    spawn: async (a) => {
      argv = a
      return { exitCode: 0, stdout: "reply text\n", stderr: "" }
    },
  })
  const out = await client.complete({ system: "SYS", prompt: "PROMPT", schema: { type: "array" } })
  expect(out).toBe("reply text")
  expect(argv[0]).toBe("opencode")
  expect(argv[1]).toBe("run")
  expect(argv[2]).toContain("SYS")
  expect(argv[2]).toContain("PROMPT")
  expect(argv[2]).toContain('"type": "array"')
  expect(argv.indexOf("--pure")).toBeGreaterThan(2) // message strictly before flags
})

test("opencode-run client throws with stderr tail on failure", async () => {
  const client = createOpencodeRunClient({
    spawn: async () => ({ exitCode: 1, stdout: "", stderr: "boom detail" }),
  })
  await expect(client.complete({ prompt: "x" })).rejects.toThrow(/boom detail/)
})

test("clientFromEnv selects backend and validates vllm config", () => {
  expect(clientFromEnv({}).describe()).toBe("opencode-run")
  expect(clientFromEnv({ AGENT_MEMORY_LLM: "vllm", AGENT_MEMORY_VLLM_URL: "http://v/v1", AGENT_MEMORY_VLLM_MODEL: "m" }).describe()).toBe("vllm/m")
  expect(() => clientFromEnv({ AGENT_MEMORY_LLM: "vllm" })).toThrow(/AGENT_MEMORY_VLLM_URL/)
})

// ============ FIX: per-call LLM timeout (AGENT_MEMORY_LLM_TIMEOUT_MS) ============

test("clientFromEnv validates AGENT_MEMORY_LLM_TIMEOUT_MS (non-numeric, and below the 1000ms floor)", () => {
  expect(() => clientFromEnv({ AGENT_MEMORY_LLM_TIMEOUT_MS: "banana" })).toThrow(/AGENT_MEMORY_LLM_TIMEOUT_MS/)
  expect(() => clientFromEnv({ AGENT_MEMORY_LLM_TIMEOUT_MS: "500" })).toThrow(/AGENT_MEMORY_LLM_TIMEOUT_MS/)
  expect(() => clientFromEnv({ AGENT_MEMORY_LLM_TIMEOUT_MS: "1.5" })).toThrow(/AGENT_MEMORY_LLM_TIMEOUT_MS/)
  // Unset -> default (600000), no throw.
  expect(clientFromEnv({}).describe()).toBe("opencode-run")
  // Valid override -> no throw.
  expect(clientFromEnv({ AGENT_MEMORY_LLM_TIMEOUT_MS: "1000" }).describe()).toBe("opencode-run")
})

test("vllm client: a hung fetch times out, rejecting with the timeout message and aborting the passed signal", async () => {
  let capturedSignal: AbortSignal | undefined
  const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined
    return new Promise<Response>(() => {}) // never resolves
  }) as unknown as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "x", fetchImpl, timeoutMs: 20 })
  await expect(client.complete({ prompt: "hi" })).rejects.toThrow(/llm call timed out after 20ms/)
  expect(capturedSignal).toBeDefined()
  expect(capturedSignal!.aborted).toBe(true)
})

test("vllm client: happy path is unaffected by a generous timeoutMs", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })) as unknown as typeof fetch
  const client = createVllmClient({ url: "http://v:8000/v1", model: "x", fetchImpl, timeoutMs: 5000 })
  const out = await client.complete({ prompt: "hi" })
  expect(out).toBe('{"ok":true}')
})

test("opencode-run client: a never-resolving spawn times out, rejecting with the timeout message", async () => {
  const client = createOpencodeRunClient({
    spawn: () => new Promise(() => {}), // never resolves
    timeoutMs: 20,
  })
  await expect(client.complete({ prompt: "x" })).rejects.toThrow(/llm call timed out after 20ms/)
})

test("opencode-run client: happy path is unaffected by a generous timeoutMs", async () => {
  const client = createOpencodeRunClient({
    spawn: async () => ({ exitCode: 0, stdout: "reply\n", stderr: "" }),
    timeoutMs: 5000,
  })
  const out = await client.complete({ prompt: "x" })
  expect(out).toBe("reply")
})

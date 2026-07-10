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

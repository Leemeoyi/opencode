import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai/effect"
import plugin from "../index.ts"
import { pairsIntact, transcript } from "./fixtures.ts"

type Tool = {
  readonly name: string
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Promise<{ output?: any; content?: any }>
}
type Hook = (event: any) => Promise<void>

// Records what the plugin registers, standing in for the OpenCode plugin host.
const load = async (options: Record<string, unknown> = {}) => {
  const storage = new Map<string, unknown>()
  const tools = new Map<string, Tool>()
  const sessionHooks = new Map<string, Hook>()
  const toolHooks = new Map<string, Hook>()
  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    model: {
      list: async () => ({
        data: [{ providerID: "deepseek", id: "deepseek-flash", limit: { context: 1_048_576, output: 393_216 } }],
      }),
    },
    session: { hook: async (name: string, fn: Hook) => void sessionHooks.set(name, fn) },
    tool: {
      hook: async (name: string, fn: Hook) => void toolHooks.set(name, fn),
      transform: async (fn: (editor: unknown) => void) => fn({ add: (tool: Tool) => tools.set(tool.name, tool) }),
    },
  }
  await plugin.setup(ctx as never)
  return { storage, tools, sessionHooks, toolHooks }
}

const contextEvent = (providerID: string, messages: Message[]) => ({
  sessionID: "ses_1",
  agent: "build",
  model: { providerID, id: providerID === "deepseek" ? "deepseek-flash" : "sonnet" },
  system: [] as { type: string; text: string }[],
  messages,
})

const small = { highTokens: 6000, lowTokens: 4000, keepTurns: 3, toolOutputLimit: 500 }

describe("context hook", () => {
  test("on an API provider: trims the transcript and appends the notes last", async () => {
    const loaded = await load(small)
    const event = contextEvent("deepseek", transcript(20, 2400))
    await loaded.sessionHooks.get("context")!(event)
    expect(event.system).toEqual([])
    const last = event.messages[event.messages.length - 1]
    expect(last.role).toBe("system")
    expect(last).toBeInstanceOf(Message)
    expect(last.content[0].type === "text" && last.content[0].text).toContain("## Your memory notes")
    expect(event.messages.length).toBeLessThan(transcript(20, 2400).length)
    expect(pairsIntact(event.messages)).toBe(true)
  })

  test("on Claude Agent: leaves the transcript alone and puts the notes in the system prompt", async () => {
    const loaded = await load(small)
    const messages = transcript(20, 2400)
    const event = contextEvent("claude-agent", messages)
    await loaded.sessionHooks.get("context")!(event)
    expect(event.messages).toBe(messages)
    expect(event.system[0].text).toContain("This conversation may be compacted")
  })

  test("with trim off: never changes the transcript", async () => {
    const loaded = await load({ ...small, trim: false })
    const messages = transcript(20, 2400)
    const event = contextEvent("deepseek", messages)
    await loaded.sessionHooks.get("context")!(event)
    expect(event.messages).toBe(messages)
  })
})

describe("tools", () => {
  test("memory: set_task, add and view, saved to storage; bad input is an error", async () => {
    const loaded = await load()
    const memory = loaded.tools.get("memory")!
    await memory.execute({ action: "set_task", text: "Fix the patrol nodes" }, { sessionID: "ses_1" })
    const added = await memory.execute({ action: "add", section: "findings", text: "DFT_PatrolNode still exists" }, { sessionID: "ses_1" })
    expect(added.content).toContain("1. DFT_PatrolNode still exists")
    expect(loaded.storage.get("notes/ses_1")).toMatchObject({ task: "Fix the patrol nodes", findings: ["DFT_PatrolNode still exists"] })
    expect(memory.execute({ action: "add", text: "no section" }, { sessionID: "ses_1" })).rejects.toThrow("add needs a section.")
    const viewed = await memory.execute({ action: "view" }, { sessionID: "ses_1" })
    expect(viewed.content).toContain("## Task\nFix the patrol nodes")
  })

  test("edits and patches are recorded in Changed automatically", async () => {
    const loaded = await load()
    const after = loaded.toolHooks.get("execute.after")!
    await after({ tool: "edit", sessionID: "ses_1", status: "completed", input: { path: "src/a.ts" }, result: {} })
    await after({ tool: "write", sessionID: "ses_1", status: "completed", input: { path: "src/b.ts" }, result: {} })
    await after({
      tool: "patch",
      sessionID: "ses_1",
      status: "completed",
      input: {},
      result: { output: { applied: [{ type: "delete", target: "src/old.ts" }] } },
    })
    await after({ tool: "edit", sessionID: "ses_1", status: "error", input: { path: "src/failed.ts" } })
    const viewed = await loaded.tools.get("memory")!.execute({ action: "view" }, { sessionID: "ses_1" })
    expect(viewed.content).toContain("1. edited src/a.ts\n2. wrote src/b.ts\n3. delete src/old.ts")
    expect(viewed.content).not.toContain("failed.ts")
  })

  test("recall returns a trimmed tool output in full by its ref, and searches older turns", async () => {
    const loaded = await load(small)
    const messages = transcript(20, 2400)
    await loaded.sessionHooks.get("context")!(contextEvent("deepseek", messages))
    const recall = loaded.tools.get("recall")!
    const full = await recall.execute({ ref: "call-0" }, { sessionID: "ses_1" })
    // Trimming keeps only the first and last 20 lines, so a middle line proves recall returns the full output.
    expect(full.content).toContain("line 30 of output 0 padding")
    const found = await recall.execute({ query: "file2.ts" }, { sessionID: "ses_1" })
    expect(found.content).toContain('ref "t2"')
  })
})

describe("compaction hook", () => {
  test("answers from the notes and a turn index instead of a model summary", async () => {
    const loaded = await load()
    await loaded.tools.get("memory")!.execute({ action: "set_task", text: "Ship the patrol fix" }, { sessionID: "ses_1" })
    const event: Record<string, any> = contextEvent("deepseek", transcript(3, 200))
    await loaded.sessionHooks.get("compaction")!(event)
    expect(event.result.summary).toContain("## Task\nShip the patrol fix")
    expect(event.result.summary).toContain('#2 user: "request 2: please look at file2.ts"')
  })
})

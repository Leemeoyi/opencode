import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai/effect"
import { index, search } from "../src/recall.ts"
import { estimate, manage, split } from "../src/transcript.ts"
import { pairsIntact, transcript, turn } from "./fixtures.ts"

const options = { high: 6000, low: 4000, keepTurns: 3, toolOutputLimit: 500 }
const texts = (messages: readonly Message[]) =>
  messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))

describe("split", () => {
  test("keeps messages before the first user message apart and groups each turn", () => {
    const parts = split(transcript(3, 100))
    expect(parts.prefix.map((message) => message.role)).toEqual(["system"])
    expect(parts.turns.map((item) => item.map((message) => message.role))).toEqual([
      ["user", "assistant", "tool", "assistant"],
      ["user", "assistant", "tool", "assistant"],
      ["user", "assistant", "tool", "assistant"],
    ])
  })
})

describe("manage", () => {
  test("leaves a request under the high mark untouched", () => {
    const messages = transcript(4, 200)
    const result = manage(messages, { evicted: 0, shrunk: 0 }, options)
    expect(result.trimmed).toBe(false)
    expect(result.messages).toEqual(messages)
  })

  test("over the high mark: keeps the task and recent turns, removes old turns, and lists them", () => {
    const messages = transcript(20, 2400)
    expect(estimate(messages)).toBeGreaterThan(options.high)
    const result = manage(messages, { evicted: 0, shrunk: 0 }, options)
    expect(result.trimmed).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(options.low)
    expect(pairsIntact(result.messages)).toBe(true)
    expect(result.messages.every((message) => message instanceof Message)).toBe(true)
    const all = texts(result.messages).join("\n")
    expect(all).toContain("request 0: please look")
    expect(all).toContain("request 19: please look")
    expect(all).toContain(`The memory plugin removed turns 1 to ${result.window.evicted}`)
    expect(all).toContain('#1 user: "request 1: please look at file1.ts"; tools: read(src/file1.ts); reply: "Done with request 1."; (recall ref "t1")')
    expect(texts(result.messages)).not.toContain(`request ${result.window.evicted}: please look at file${result.window.evicted}.ts`)
  })

  test("shortens old tool outputs with a recall ref, and keeps recent ones whole", () => {
    const messages = transcript(20, 2400)
    const result = manage(messages, { evicted: 0, shrunk: 0 }, options)
    const outputs = result.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-result" ? [{ id: part.id, value: String(part.result.value) }] : [])),
    )
    expect(outputs.find((item) => item.id === "call-0")?.value).toContain('recall with ref "call-0" returns the full output')
    expect(outputs.find((item) => item.id === "call-19")?.value).not.toContain("trimmed")
  })

  test("keeps the start of the request identical between trims, so prompt caching works", () => {
    const first = manage(transcript(20, 2400), { evicted: 0, shrunk: 0 }, options)
    const grown = [...transcript(20, 2400), ...turn(20, "short output")]
    const second = manage(grown, first.window, options)
    expect(second.trimmed).toBe(false)
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
  })

  test("when removing turns is not enough, shortens recent turns' outputs too, but never the current turn's", () => {
    const result = manage(transcript(6, 20_000), { evicted: 0, shrunk: 0 }, options)
    const outputs = result.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-result" ? [{ id: part.id, value: String(part.result.value) }] : [])),
    )
    expect(result.window).toEqual({ evicted: 2, shrunk: 5 })
    expect(outputs.find((item) => item.id === "call-4")?.value).toContain("trimmed by the memory plugin")
    expect(outputs.find((item) => item.id === "call-5")?.value).not.toContain("trimmed")
    expect(pairsIntact(result.messages)).toBe(true)
  })

  test("never removes the first turn or the most recent turns, even when that leaves it over the low mark", () => {
    const result = manage(transcript(4, 20_000), { evicted: 0, shrunk: 0 }, { ...options, toolOutputLimit: 100_000 })
    const all = texts(result.messages).join("\n")
    expect(["request 0", "request 1", "request 2", "request 3"].every((text) => all.includes(text))).toBe(true)
    expect(pairsIntact(result.messages)).toBe(true)
  })
})

describe("recall", () => {
  test("indexes turns and full tool outputs, and ranks by matched words", () => {
    const entries = index(transcript(5, 300))
    expect(entries.find((entry) => entry.ref === "call-3")?.text).toContain("line 0 of output 3")
    expect(entries.find((entry) => entry.ref === "t2")?.text).toContain("request 2")
    const results = search(entries, "file4 request", 3)
    expect(results[0].ref).toBe("t4")
    expect(results[0].excerpt).toContain("file4")
    expect(search(entries, "nothing-matches-this", 3)).toEqual([])
  })
})

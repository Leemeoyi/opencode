import type { Message } from "@opencode/ai/effect"

type Part = Message["content"][number]
type ToolResult = Extract<Part, { type: "tool-result" }>
type ToolCall = Extract<Part, { type: "tool-call" }>

// An image or document part costs roughly this many tokens; its bytes are not text.
const mediaTokens = 1500

export const resultText = (result: ToolResult["result"]): string => {
  if (result.type === "content")
    return result.value.map((item) => (item.type === "text" ? item.text : `[file: ${item.name ?? item.mime}]`)).join("\n")
  if (typeof result.value === "string") return result.value
  return JSON.stringify(result.value) ?? ""
}

const partText = (part: Part): string => {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "tool-call") return `${part.name} ${JSON.stringify(part.input) ?? ""}`
  if (part.type === "tool-result") return resultText(part.result)
  if (part.type === "compaction") return part.text ?? ""
  return ""
}

const partTokens = (part: Part) => {
  if (part.type === "media") return mediaTokens
  if (part.type === "tool-result" && part.result.type === "content")
    return part.result.value.reduce(
      (total, item) => total + (item.type === "text" ? Math.ceil(item.text.length / 4) : mediaTokens),
      0,
    )
  return Math.ceil(partText(part).length / 4)
}

export const estimate = (messages: readonly Message[]) =>
  messages.reduce((total, message) => total + message.content.reduce((sum, part) => sum + partTokens(part), 0), 0)

/**
 * Splits a transcript into the messages before the first user message and turns: a user message plus every
 * assistant, tool and system message after it. Removing whole turns never separates a tool call from its result.
 */
export const split = (messages: readonly Message[]) => {
  const first = messages.findIndex((message) => message.role === "user")
  if (first === -1) return { prefix: [...messages], turns: [] as Message[][] }
  const turns = messages.slice(first).reduce<Message[][]>((all, message) => {
    if (message.role === "user") return [...all, [message]]
    all[all.length - 1].push(message)
    return all
  }, [])
  return { prefix: messages.slice(0, first), turns }
}

/** Copies a message with new content, keeping its class so later code that relies on it still works. */
const withContent = (message: Message, content: Part[]): Message =>
  Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content })

const clip = (text: string, id: string, limit: number) => {
  const lines = text.split("\n")
  const head = lines.slice(0, 20).join("\n").slice(0, limit / 2)
  const tail = lines.slice(-20).join("\n").slice(-limit / 2)
  const omitted = text.length - head.length - tail.length
  return `${head}\n[... ${omitted} characters trimmed by the memory plugin; recall with ref "${id}" returns the full output ...]\n${tail}`
}

/** Shortens long or file-carrying tool outputs to their start and end, keeping the call and result paired. */
export const shrink = (message: Message, limit: number): Message => {
  const shrinkable = (part: Part): part is ToolResult =>
    part.type === "tool-result" &&
    (resultText(part.result).length > limit ||
      (part.result.type === "content" && part.result.value.some((item) => item.type !== "text")))
  if (!message.content.some(shrinkable)) return message
  return withContent(
    message,
    message.content.map((part) =>
      shrinkable(part) ? { ...part, result: { type: "text", value: clip(resultText(part.result), part.id, limit) } } : part,
    ),
  )
}

const keyInput = (call: ToolCall) => {
  const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {}
  const value = ["path", "filePath", "file_path", "command", "query", "pattern", "action", "map", "filter", "url"]
    .map((key) => input[key])
    .find((item) => typeof item === "string")
  return typeof value === "string" ? `(${value.length > 60 ? `${value.slice(0, 60)}...` : value})` : ""
}

const oneLine = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat
}

/** One line describing a turn: what the user asked, the tools used, and how the agent's reply began. */
export const describeTurn = (turn: readonly Message[], number: number) => {
  const parts = turn.flatMap((message) => message.content.map((part) => ({ role: message.role, part })))
  const asked = parts
    .filter((item) => item.role === "user" && item.part.type === "text")
    .map((item) => partText(item.part))
    .join(" ")
  const calls = parts.flatMap((item) => (item.part.type === "tool-call" ? [`${item.part.name}${keyInput(item.part)}`] : []))
  const replies = parts.filter((item) => item.role === "assistant" && item.part.type === "text")
  const reply = replies.length ? partText(replies[replies.length - 1].part) : ""
  return [
    `#${number} user: "${oneLine(asked, 120)}"`,
    ...(calls.length ? [`tools: ${[...new Set(calls)].slice(0, 8).join(", ")}${calls.length > 8 ? ", ..." : ""}`] : []),
    ...(reply ? [`reply: "${oneLine(reply, 100)}"`] : []),
    `(recall ref "t${number}")`,
  ].join("; ")
}

export type Window = {
  /** Turns 1 to `evicted` are left out of the request. Turn 0, the original task, is always kept. */
  readonly evicted: number
  /** Turns before this index have their long tool outputs shortened. */
  readonly shrunk: number
}

export type Options = {
  /** Start trimming when the request is estimated above this many tokens. */
  readonly high: number
  /** Trim down to below this many tokens. */
  readonly low: number
  /** The most recent turns, always kept verbatim. */
  readonly keepTurns: number
  /** Tool outputs longer than this many characters are shortened in trimmed turns. */
  readonly toolOutputLimit: number
}

const assemble = (parts: ReturnType<typeof split>, window: Window, options: Options) => {
  const kept = parts.turns.flatMap((turn, index) =>
    index === 0 || index > window.evicted
      ? [index < window.shrunk ? turn.map((message) => shrink(message, options.toolOutputLimit)) : turn]
      : [],
  )
  if (window.evicted === 0 || kept.length < 2) return [...parts.prefix, ...kept.flat()]
  const note = [
    `[The memory plugin removed turns 1 to ${window.evicted} from this request to keep it focused. They are listed below; use the recall tool with a ref, or a search, for details. Your memory notes hold the task, decisions and findings.]`,
    ...parts.turns.slice(1, window.evicted + 1).map((turn, index) => describeTurn(turn, index + 1)),
  ].join("\n")
  const [first, ...rest] = kept[1]
  return [
    ...parts.prefix,
    ...kept[0],
    withContent(first, [{ type: "text", text: note }, ...first.content]),
    ...rest,
    ...kept.slice(2).flat(),
  ]
}

/**
 * Decides what the next request contains. The window only changes when the request grows past the high mark; then
 * old tool outputs are shortened and the oldest turns removed until it is under the low mark. Between those moments
 * the start of the request stays the same, so provider prompt caching keeps working.
 */
export const manage = (messages: readonly Message[], previous: Window, options: Options) => {
  const parts = split(messages)
  const oldest = Math.max(0, parts.turns.length - options.keepTurns)
  const window = {
    evicted: Math.min(previous.evicted, Math.max(0, oldest - 1)),
    shrunk: Math.min(previous.shrunk, Math.max(0, parts.turns.length - 1)),
  }
  const unchanged = assemble(parts, window, options)
  const tokens = estimate(unchanged)
  if (tokens <= options.high) return { messages: unchanged, window, tokens, trimmed: false }
  // Once no more turns can be removed, the recent turns' long tool outputs are shortened too, except the current turn's.
  const current = Math.max(0, parts.turns.length - 1)
  const trim = (candidate: Window): { messages: Message[]; window: Window; tokens: number } => {
    const assembled = assemble(parts, candidate, options)
    const size = estimate(assembled)
    if (size <= options.low) return { messages: assembled, window: candidate, tokens: size }
    if (candidate.evicted < oldest - 1) return trim({ ...candidate, evicted: candidate.evicted + 1 })
    if (candidate.shrunk < current) return trim({ ...candidate, shrunk: current })
    return { messages: assembled, window: candidate, tokens: size }
  }
  return { ...trim({ evicted: window.evicted, shrunk: oldest }), trimmed: true }
}

/** A turn's own text: what the user wrote, the agent's replies and its tool calls, without tool outputs. */
export const turnText = (turn: readonly Message[]) =>
  turn
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "tool-result" || part.type === "reasoning" ? [] : [`${message.role}: ${partText(part)}`],
      ),
    )
    .join("\n")

export const toolResults = (turn: readonly Message[]) =>
  turn.flatMap((message) => message.content.filter((part): part is ToolResult => part.type === "tool-result"))

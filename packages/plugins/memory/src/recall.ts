import type { Message } from "@opencode/ai/effect"
import { resultText, split, toolResults, turnText } from "./transcript.js"

export type Entry = {
  /** "t<turn>" for a whole turn, or the tool call ID for a tool output. */
  readonly ref: string
  readonly turn: number
  readonly label: string
  readonly text: string
}

/** Searchable pieces of a transcript: each turn's own text, and each tool output on its own. */
export const index = (messages: readonly Message[]): Entry[] =>
  split(messages).turns.flatMap((turn, number) => [
    { ref: `t${number}`, turn: number, label: `turn ${number}`, text: turnText(turn) },
    ...toolResults(turn).map((part) => ({
      ref: part.id,
      turn: number,
      label: `${part.name} output in turn ${number}`,
      text: resultText(part.result),
    })),
  ])

const excerpt = (text: string, terms: readonly string[]) => {
  const lower = text.toLowerCase()
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0))
  const start = Math.max(0, at - 150)
  const flat = text.slice(start, at + 250).replace(/\s+/g, " ").trim()
  return `${start > 0 ? "..." : ""}${flat}${at + 250 < text.length ? "..." : ""}`
}

/** Entries ranked by how many query words they contain, then how often, newest first on ties. */
export const search = (entries: readonly Entry[], query: string, limit: number) => {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 1))]
  if (terms.length === 0) return []
  return entries
    .map((entry) => {
      const lower = entry.text.toLowerCase()
      const counts = terms.map((term) => lower.split(term).length - 1)
      return { entry, matched: counts.filter((count) => count > 0).length, hits: counts.reduce((a, b) => a + b, 0) }
    })
    .filter((item) => item.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.hits - a.hits || b.entry.turn - a.entry.turn)
    .slice(0, limit)
    .map((item) => ({ ...item.entry, excerpt: excerpt(item.entry.text, terms) }))
}

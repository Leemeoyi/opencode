/** Sections of a session's memory notes. "changed" is filled from tool calls, not by the agent. */
export const lists = ["decisions", "findings", "changed", "open", "next"] as const
export type ListSection = (typeof lists)[number]

export type Notes = {
  task: string
  decisions: string[]
  findings: string[]
  changed: string[]
  open: string[]
  next: string[]
}

const titles: Record<ListSection, string> = {
  decisions: "Decisions",
  findings: "Findings",
  changed: "Changed (recorded automatically)",
  open: "Open problems and questions",
  next: "Next",
}

// Changed is capped by count rather than by the budget, so tracking never fails an edit.
const changedLimit = 60

export const empty = (): Notes => ({ task: "", decisions: [], findings: [], changed: [], open: [], next: [] })

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** Reads notes saved by an earlier version or session, dropping anything malformed. */
export const decode = (value: unknown): Notes => {
  if (typeof value !== "object" || value === null) return empty()
  const record = value as Record<string, unknown>
  const list = (key: ListSection) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string") : []
  return {
    task: typeof record.task === "string" ? record.task : "",
    decisions: list("decisions"),
    findings: list("findings"),
    changed: list("changed"),
    open: list("open"),
    next: list("next"),
  }
}

export const render = (notes: Notes) =>
  [
    "## Task",
    notes.task || "(not set)",
    ...lists.flatMap((section) => [
      "",
      `## ${titles[section]}`,
      ...(notes[section].length ? notes[section].map((item, index) => `${index + 1}. ${item}`) : ["(none)"]),
    ]),
  ].join("\n")

export const size = (notes: Notes) => estimateTokens(render(notes))

export type Edit =
  | { readonly action: "set_task"; readonly text: string }
  | { readonly action: "add"; readonly section: ListSection; readonly text: string }
  | { readonly action: "update"; readonly section: ListSection; readonly index: number; readonly text: string }
  | { readonly action: "remove"; readonly section: ListSection; readonly index: number }

/** Applies an agent's edit, or explains why it was refused. Indexes are 1-based, as `render` shows them. */
export const apply = (notes: Notes, edit: Edit, budget: number): { notes: Notes } | { error: string } => {
  const next = structuredClone(notes)
  if (edit.action === "set_task") next.task = edit.text.trim()
  if (edit.action === "add") next[edit.section].push(edit.text.trim())
  if (edit.action === "update" || edit.action === "remove") {
    if (edit.index < 1 || edit.index > next[edit.section].length)
      return { error: `${edit.section} has no item ${edit.index}; it has ${next[edit.section].length}.` }
    if (edit.action === "update") next[edit.section][edit.index - 1] = edit.text.trim()
    if (edit.action === "remove") next[edit.section].splice(edit.index - 1, 1)
  }
  const grows = edit.action !== "remove"
  if (grows && size(next) > budget)
    return {
      error: `The notes would be ${size(next)} tokens, over the ${budget}-token budget. Shorten items or remove ones that are done or out of date, then try again.`,
    }
  return { notes: next }
}

/** Records a changed file or asset, newest last, without repeats. */
export const track = (notes: Notes, entry: string): Notes => {
  const changed = [...notes.changed.filter((item) => item !== entry), entry]
  return { ...notes, changed: changed.slice(-changedLimit) }
}

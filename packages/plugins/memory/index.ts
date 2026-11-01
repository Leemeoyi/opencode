import { Plugin } from "@opencode/plugin"
import type { Message } from "@opencode/ai/effect"
import { Schema } from "effect"
import { appendFile } from "node:fs/promises"
import { apply, decode, type Edit, lists, type Notes, render, track } from "./src/notes.js"
import { type Entry, index, search } from "./src/recall.js"
import { describeTurn, estimate, manage, split, type Window } from "./src/transcript.js"

// Claude Agent runs Claude Code, which keeps and compacts its own transcript; only the notes and recall apply there.
const claudeAgent = "claude-agent"

const positive = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback)

const guide = (claude: boolean) =>
  [
    "# Memory",
    "You keep session memory notes with the memory tool. They are your record of the work: keep them current as you go, not at the end.",
    "- At the start of a task, set_task with the goal in the user's words.",
    "- Add decisions (what was chosen and why, what the user approved or ruled out), findings (facts learned about the project), open problems and next steps as they happen. Remove or update items when they stop being true.",
    "- Changed files are recorded automatically.",
    "- Use the recall tool to search the whole session history or to get a full earlier tool output by its ref.",
    claude
      ? "- This conversation may be compacted. After that, or whenever you are unsure what you were doing, call memory with action view before continuing."
      : "- Older turns may be removed from your context to keep it focused; a note lists them. Your notes are below, and recall finds anything else.",
  ].join("\n")

export default Plugin.define({
  id: "leemeoyi.memory",
  async setup(ctx) {
    const settings = {
      trim: ctx.options.trim !== false,
      highTokens: positive(ctx.options.highTokens, 120_000),
      lowTokens: positive(ctx.options.lowTokens, 80_000),
      keepTurns: positive(ctx.options.keepTurns, 6),
      toolOutputLimit: positive(ctx.options.toolOutputLimit, 2000),
      memoryBudget: positive(ctx.options.memoryBudget, 1500),
    }

    const notes = new Map<string, Notes>()
    const pending = new Map<string, Promise<unknown>>()
    const transcripts = new Map<string, Entry[]>()
    const windows = new Map<string, Window>()
    const contextLimits = new Map<string, number | undefined>()

    const load = async (sessionID: string) => {
      const cached = notes.get(sessionID)
      if (cached) return cached
      const loaded = decode(await ctx.storage.get(`notes/${sessionID}`))
      notes.set(sessionID, loaded)
      return loaded
    }

    // Edits to one session's notes run one at a time, so concurrent tool calls cannot overwrite each other.
    const change = <Result,>(sessionID: string, edit: (current: Notes) => { notes?: Notes; result: Result }) => {
      const run = (pending.get(sessionID) ?? Promise.resolve()).then(async () => {
        const outcome = edit(await load(sessionID))
        if (outcome.notes) {
          notes.set(sessionID, outcome.notes)
          await ctx.storage.set(`notes/${sessionID}`, outcome.notes)
        }
        return outcome.result
      })
      pending.set(sessionID, run.catch(() => undefined))
      return run
    }

    const contextLimit = async (model: { readonly providerID: string; readonly id: string }) => {
      const key = `${model.providerID}/${model.id}`
      if (contextLimits.has(key)) return contextLimits.get(key)
      const found = (await ctx.model.list()).data.find((item) => item.providerID === model.providerID && item.id === model.id)
      contextLimits.set(key, found?.limit.context)
      return found?.limit.context
    }

    await ctx.session.hook("context", async (event) => {
      transcripts.set(event.sessionID, index(event.messages))
      const claude = event.model.providerID === claudeAgent
      const memory = `${guide(claude)}\n\n## Your memory notes\n\n${render(await load(event.sessionID))}`
      // Claude Code reads the system prompt when its process starts, so the notes go there.
      if (claude || !settings.trim || event.messages.length === 0) {
        event.system.push({ type: "text", text: memory })
        return
      }
      const limit = await contextLimit(event.model)
      const result = manage(event.messages, windows.get(event.sessionID) ?? { evicted: 0, shrunk: 0 }, {
        high: Math.min(settings.highTokens, limit ? limit * 0.6 : Infinity),
        low: Math.min(settings.lowTokens, limit ? limit * 0.4 : Infinity),
        keepTurns: settings.keepTurns,
        toolOutputLimit: settings.toolOutputLimit,
      })
      windows.set(event.sessionID, result.window)
      if (typeof ctx.options.debugFile === "string")
        await appendFile(
          ctx.options.debugFile,
          `${JSON.stringify({
            time: new Date().toISOString(),
            sessionID: event.sessionID,
            model: `${event.model.providerID}/${event.model.id}`,
            messages: event.messages.length,
            before: estimate(event.messages),
            after: result.tokens,
            trimmed: result.trimmed,
            ...result.window,
          })}\n`,
        )
      // The notes change often, so they go last: everything before them stays identical between requests and stays
      // in the provider's prompt cache.
      const template = event.messages[0]
      const notesMessage: Message = Object.assign(Object.create(Object.getPrototypeOf(template)), {
        role: "system",
        content: [{ type: "text", text: memory }],
      })
      event.messages = [...result.messages, notesMessage]
    })

    // If a provider still rejects a request as too long, answer compaction from the notes and a turn index instead
    // of a model-written summary.
    await ctx.session.hook("compaction", async (event) => {
      if (event.model.providerID === claudeAgent || !settings.trim) return
      const turns = split(event.messages).turns
      const listed = turns.slice(-300).map((turn, position) => describeTurn(turn, turns.length - Math.min(300, turns.length) + position))
      event.result = {
        summary: [
          "Summary written by the memory plugin from the session's memory notes and an index of its turns. Use the recall tool for details.",
          "",
          render(await load(event.sessionID)),
          "",
          "## Turns",
          ...listed,
        ].join("\n"),
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const input = typeof event.input === "object" && event.input !== null ? (event.input as Record<string, unknown>) : {}
      const output = event.result.output
      const applied =
        event.tool === "patch" && typeof output === "object" && output !== null && "applied" in output && Array.isArray(output.applied)
          ? (output.applied as { type?: unknown; target?: unknown }[])
          : []
      const entries = [
        ...(event.tool === "edit" && typeof input.path === "string" ? [`edited ${input.path}`] : []),
        ...(event.tool === "write" && typeof input.path === "string" ? [`wrote ${input.path}`] : []),
        ...applied.flatMap((item) => (typeof item.target === "string" ? [`${String(item.type ?? "patched")} ${item.target}`] : [])),
      ]
      if (entries.length === 0) return
      await change(event.sessionID, (current) => ({
        notes: entries.reduce((next, entry) => track(next, entry), current),
        result: undefined,
      }))
    })

    const editable = lists.filter((section) => section !== "changed")

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "memory",
        options: { codemode: false },
        description: [
          "View or edit this session's memory notes: the task, decisions, findings, open problems and next steps.",
          "They stay in your context for the whole session, even when older turns are removed or compacted.",
          `Keep them short; the whole document has a budget of about ${settings.memoryBudget} tokens.`,
          "Item numbers are 1-based, as view shows them.",
        ].join(" "),
        input: Schema.Struct({
          action: Schema.Literals(["view", "set_task", "add", "update", "remove"]),
          section: Schema.optionalKey(Schema.Literals(["decisions", "findings", "open", "next"])).annotate({
            description: "Required for add, update and remove.",
          }),
          text: Schema.optionalKey(Schema.String).annotate({ description: "Required for set_task, add and update." }),
          index: Schema.optionalKey(Schema.Number).annotate({ description: "Item number, for update and remove." }),
        }),
        output: Schema.Struct({ notes: Schema.String }),
        execute: async (input, context) => {
          if (input.action === "view") {
            const text = render(await load(context.sessionID))
            return { output: { notes: text }, content: text }
          }
          const edit = ((): Edit | string => {
            if (input.action === "set_task") return input.text ? { action: "set_task", text: input.text } : "set_task needs text."
            if (!input.section || !editable.includes(input.section)) return `${input.action} needs a section.`
            if (input.action === "add") return input.text ? { action: "add", section: input.section, text: input.text } : "add needs text."
            if (input.index === undefined) return `${input.action} needs an index.`
            if (input.action === "remove") return { action: "remove", section: input.section, index: input.index }
            return input.text ? { action: "update", section: input.section, index: input.index, text: input.text } : "update needs text."
          })()
          if (typeof edit === "string") throw new Error(edit)
          const outcome = await change<{ error: string } | { text: string }>(context.sessionID, (current) => {
            const applied = apply(current, edit, settings.memoryBudget)
            if ("error" in applied) return { result: { error: applied.error } }
            return { notes: applied.notes, result: { text: render(applied.notes) } }
          })
          if ("error" in outcome) throw new Error(outcome.error)
          return { output: { notes: outcome.text }, content: outcome.text }
        },
      })

      tools.add({
        name: "recall",
        options: { codemode: false },
        description: [
          "Search this session's whole history, including turns no longer in your context and full tool outputs,",
          'or fetch one item by ref (a turn such as "t12", or a tool output ID from a trimmed output or an earlier search).',
        ].join(" "),
        input: Schema.Struct({
          query: Schema.optionalKey(Schema.String).annotate({ description: "Words to search for" }),
          ref: Schema.optionalKey(Schema.String).annotate({ description: "Fetch this item's full text" }),
          limit: Schema.optionalKey(Schema.Number).annotate({ description: "Maximum search results. Default 8." }),
        }),
        output: Schema.Struct({ results: Schema.Number }),
        execute: async (input, context) => {
          const entries = transcripts.get(context.sessionID) ?? []
          if (input.ref) {
            const found = entries.find((entry) => entry.ref === input.ref)
            if (!found) throw new Error(`No item with ref "${input.ref}". Search first to find refs.`)
            const text = found.text.length > 40_000 ? `${found.text.slice(0, 40_000)}\n[... ${found.text.length - 40_000} more characters]` : found.text
            return { output: { results: 1 }, content: `${found.label} (ref "${found.ref}"):\n${text}` }
          }
          if (!input.query) throw new Error("Give a query to search, or a ref to fetch.")
          const results = search(entries, input.query, Math.max(1, input.limit ?? 8))
          return {
            output: { results: results.length },
            content: results.length
              ? results.map((item) => `ref "${item.ref}" | ${item.label}\n  ${item.excerpt}`).join("\n")
              : `Nothing in this session's history matches "${input.query}".`,
          }
        },
      })
    })
  },
})

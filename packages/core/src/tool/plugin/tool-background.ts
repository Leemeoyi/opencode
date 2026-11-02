export * as ToolBackground from "./tool-background.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Ref, Schema, Scope } from "effect"
import { Agent } from "../../agent.js"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Tool } from "../../tool.js"
import { SubagentWaitTool } from "./subagent-wait.js"

export const startName = "tool_start"
export const waitName = "tool_wait"

const OUTPUT_LIMIT = 8000
const MAX_TIMEOUT = 3600
const MAX_IDS = 20
// Starting these in the background would nest waits or ask the user a question nobody is there to answer.
const REFUSED = new Set([startName, waitName, SubagentWaitTool.name, "question"])

export const StartInput = Schema.Struct({
  tool: Schema.String.annotate({ description: "Name of the tool to run, exactly as you would call it" }),
  input: Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "The tool's arguments" }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "A few words saying what this call does" }),
})

export const StartOutput = Schema.Struct({ jobID: Schema.String })

export const WaitInput = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description: "Job IDs from tool_start, shell IDs of background shell commands, or sessionIDs of background subagents",
  }),
  mode: Schema.optionalKey(Schema.Literals(["all", "any", "quorum"])).annotate({
    description:
      '"all" (default): wait until every job has finished. "any": return when the first one completes successfully. "quorum": return when count of them have completed successfully.',
  }),
  count: Schema.optionalKey(Schema.Number).annotate({ description: 'For "quorum": how many successful completions to wait for' }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: `Seconds to wait at most, up to ${MAX_TIMEOUT}. Default 600. 0 checks once and returns at once. On timeout, the results so far are returned.`,
  }),
  cancelRest: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Cancel the jobs still running when the wait ends. Default false.",
  }),
})

const Result = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  output: Schema.optionalKey(Schema.String),
})

export const WaitOutput = Schema.Struct({
  satisfied: Schema.Boolean,
  timedOut: Schema.Boolean,
  results: Schema.Array(Result),
})

export const startDescription = [
  "Start any other tool call in the background and return a job ID at once, so you can keep working while it runs.",
  "Use it for slow calls such as builds, test runs, playtests or long shell commands, especially several at the same time.",
  "The tool runs with the same permissions as a direct call. When it finishes you get a <tool> notice with its result,",
  `unless ${waitName} already returned that result. Use ${waitName} to wait for one, any, all or a quorum of jobs.`,
  "Do not set the started tool's own background flag; it is ignored, since the call already runs in the background.",
  `You cannot start ${[...REFUSED].join(", ")} this way.`,
].join("\n")

export const waitDescription = [
  "Wait for background work started by this session: jobs from tool_start, shell commands run with background=true, and subagents started with background=true.",
  "Wait for all of them, the first to succeed, or a quorum of successes. Returns each job's status and output. Jobs still running keep running unless cancelRest is set.",
  "Use it when you need the results before continuing, instead of ending your turn.",
  "You may still receive completion notices for these jobs afterwards; ignore the ones whose results you already have.",
].join("\n")

type Outcome = { readonly status: Job.Status; readonly text?: string }

/** One job the wait tracks: what to call it, and how to wait for its outcome. */
type Target = { readonly id: string; readonly description: string; readonly outcome: Effect.Effect<Outcome, ToolFailure> }

const clip = (text: string) =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[... ${text.length - OUTPUT_LIMIT} more characters]` : text

const fromJob = (info: Job.Info): Outcome => ({
  status: info.status,
  text: info.status === "completed" ? info.output : info.status === "error" ? info.error : undefined,
})

const contentText = (content: ReadonlyArray<{ type: "text"; text: string } | { type: "file"; mime: string }>) =>
  content.map((item) => (item.type === "text" ? item.text : `[${item.mime} output omitted]`)).join("\n\n")

export const Plugin = {
  id: "opencode.tool.background",
  effect: Effect.fn("ToolBackground.Plugin")(function* (ctx: Context) {
    const agents = yield* Agent.Service
    const jobs = yield* Job.Service
    const registry = yield* Tool.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    // Jobs whose result a wait already returned, so their completion notice is skipped.
    const delivered = new Set<string>()
    // The waits watching each job. A notice waits for them to end, so a job that finishes during a wait is reported
    // by that wait alone.
    const watchers = new Map<string, Set<Deferred.Deferred<void>>>()

    const notifyWhenDone = Effect.fn("ToolBackground.notifyWhenDone")(
      function* (sessionID: SessionSchema.ID, id: string, tool: string, description: string) {
        const info = (yield* jobs.wait({ id })).info
        if (!info || info.status === "running") return
        yield* Effect.forEach([...(watchers.get(id) ?? [])], Deferred.await, { discard: true })
        if (delivered.delete(id)) return
        const outcome = fromJob(info)
        yield* sessions.synthetic({
          sessionID,
          description,
          text: `<tool id="${id}" tool="${tool}" state="${info.status}" description="${description}">\n${outcome.text ?? (info.status === "cancelled" ? "Cancelled" : "No output.")}\n</tool>`,
          metadata: { source: "tool", jobID: id, tool, state: info.status },
        })
      },
      (effect) => effect.pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true })),
    )

    const start = Effect.fnUntraced(function* (input: typeof StartInput.Type, context: Tool.Context) {
      if (REFUSED.has(input.tool))
        return yield* new ToolFailure({ message: `${input.tool} cannot be started in the background.` })
      const session = yield* sessions
        .get(context.sessionID)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: "Session not found", error })))
      const agent = yield* agents.get(context.agent)
      // The same permissions the session's own tool snapshot uses, so a tool it cannot call stays unavailable.
      const tools = yield* registry.snapshot(Permission.merge(agent?.permissions ?? [], session.permissions ?? []))
      if (!tools.definitions.some((definition) => definition.name === input.tool))
        return yield* new ToolFailure({ message: `No tool named "${input.tool}" is available to this session.` })
      const id = `tool_${Bun.randomUUIDv7()}`
      const description = input.description ?? input.tool
      yield* jobs.start({
        id,
        type: "tool",
        title: description,
        metadata: { sessionID: context.sessionID, tool: input.tool },
        run: tools
          .execute({
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            // A tool's own background flag would hand back a placeholder instead of the result, with the real
            // result arriving in a separate notice. The job is already in the background, so the call runs to the end.
            call: {
              type: "tool-call",
              id: context.id,
              name: input.tool,
              input: Object.fromEntries(Object.entries(input.input).filter(([key]) => key !== "background")),
            },
          })
          .pipe(Effect.map((result) => contentText(result.content))),
      })
      yield* notifyWhenDone(context.sessionID, id, input.tool, description)
      return {
        output: { jobID: id },
        content: `Started ${input.tool} in the background (job ID: ${id}). You will be notified when it finishes, or call ${waitName} to wait for it.`,
      }
    })

    // A job of this session, or a background subagent of it. A subagent that already delivered its result no longer
    // has a job; its own session still holds the reply.
    const target = Effect.fnUntraced(function* (id: string, sessionID: SessionSchema.ID) {
      const info = yield* jobs.get(id)
      if (info && info.type !== "subagent") {
        if (info.metadata?.sessionID !== sessionID)
          return yield* new ToolFailure({ message: `Job ${id} does not belong to the current session` })
        return {
          id,
          description: info.title ?? id,
          outcome: jobs.wait({ id }).pipe(Effect.map((result) => fromJob(result.info ?? info))),
        }
      }
      if (!Schema.is(SessionSchema.ID)(id)) return yield* new ToolFailure({ message: `Unknown job ID: ${id}` })
      const child = yield* sessions
        .get(id)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unknown job ID: ${id}`, error })))
      if (child.parentID !== sessionID)
        return yield* new ToolFailure({ message: `Session ${id} is not a subagent of the current session` })
      return {
        id,
        description: child.title ?? id,
        outcome: info
          ? jobs.wait({ id }).pipe(
              Effect.flatMap((result) =>
                result.info === undefined || result.info.status === "running"
                  ? SubagentWaitTool.fromSession(sessions, child.id)
                  : Effect.succeed(fromJob(result.info)),
              ),
            )
          : SubagentWaitTool.fromSession(sessions, child.id),
      }
    })

    const wait = Effect.fnUntraced(function* (input: typeof WaitInput.Type, context: Tool.Context) {
      const ids = [...new Set(input.ids)]
      if (ids.length === 0 || ids.length > MAX_IDS)
        return yield* new ToolFailure({ message: `Give between 1 and ${MAX_IDS} job IDs.` })
      const mode = input.mode ?? "all"
      const need = mode === "all" ? ids.length : mode === "any" ? 1 : Math.floor(input.count ?? 0)
      if (need < 1 || need > ids.length)
        return yield* new ToolFailure({
          message: `quorum needs a count between 1 and ${ids.length}, the number of IDs given.`,
        })
      const targets: ReadonlyArray<Target> = yield* Effect.forEach(ids, (id) => target(id, context.sessionID))
      const release = yield* Deferred.make<void>()
      for (const id of ids) watchers.set(id, (watchers.get(id) ?? new Set()).add(release))
      return yield* collect(input, ids, need, targets).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            for (const id of ids) {
              const set = watchers.get(id)
              set?.delete(release)
              if (set?.size === 0) watchers.delete(id)
            }
            return Deferred.succeed(release, undefined)
          }),
        ),
      )
    })

    const collect = Effect.fnUntraced(function* (
      input: typeof WaitInput.Type,
      ids: ReadonlyArray<string>,
      need: number,
      targets: ReadonlyArray<Target>,
    ) {
      const mode = input.mode ?? "all"
      // Each job's wait records its outcome; the first moment the condition holds, or every job has finished
      // without it, ends the wait.
      const finished = yield* Ref.make(new Map<string, Outcome>())
      const settled = yield* Deferred.make<void>()
      const decide = (done: ReadonlyMap<string, Outcome>) => {
        if (done.size === ids.length) return true
        return mode !== "all" && [...done.values()].filter((item) => item.status === "completed").length >= need
      }
      const seconds = Math.min(MAX_TIMEOUT, Math.max(0, input.timeout ?? 600))
      const ended = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forEach(
            targets,
            (item) =>
              item.outcome.pipe(
                Effect.flatMap((result) => Ref.updateAndGet(finished, (done) => new Map(done).set(item.id, result))),
                Effect.flatMap((done) => (decide(done) ? Deferred.succeed(settled, undefined) : Effect.void)),
              ),
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          // With no timeout, give jobs that already finished one turn to report.
          if (seconds === 0) yield* Effect.yieldNow
          return yield* Deferred.await(settled).pipe(Effect.timeoutOption(seconds * 1000))
        }),
      )
      const timedOut = ended._tag === "None"

      const done = yield* Ref.get(finished)
      for (const id of done.keys()) delivered.add(id)
      const running = ids.filter((id) => !done.has(id))
      if (input.cancelRest) yield* Effect.forEach(running, (id) => jobs.cancel(id), { discard: true })
      const results = targets.map((item) => {
        const result = done.get(item.id)
        const status = result?.status ?? (input.cancelRest ? ("cancelled" as const) : ("running" as const))
        return {
          id: item.id,
          description: item.description,
          status,
          ...(result?.text === undefined ? {} : { output: clip(result.text) }),
        }
      })
      // Cancelled jobs report through this result, not a notice.
      if (input.cancelRest) for (const id of running) delivered.add(id)
      const successes = results.filter((result) => result.status === "completed").length
      const satisfied = mode === "all" ? running.length === 0 : successes >= need

      const heading = timedOut
        ? seconds === 0
          ? `${ids.length - running.length} of ${ids.length} jobs have finished.`
          : `Stopped waiting after ${seconds}s.`
        : satisfied
          ? mode === "all"
            ? "All jobs finished."
            : `${successes} of ${ids.length} jobs completed successfully, meeting the ${mode === "any" ? "first success" : `quorum of ${need}`}.`
          : `Every job finished, but only ${successes} completed successfully; ${need} were needed.`
      const content = [
        heading,
        ...results.map((result) =>
          [
            `<job id="${result.id}" state="${result.status}" description="${result.description}">`,
            result.output ??
              (result.status === "running"
                ? "Still running."
                : result.status === "cancelled"
                  ? "Cancelled before it finished."
                  : "No output."),
            "</job>",
          ].join("\n"),
        ),
      ].join("\n\n")
      return { output: { satisfied, timedOut, results }, content }
    })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: startName,
          options: { codemode: false },
          description: startDescription,
          input: StartInput,
          output: StartOutput,
          execute: start,
        })
        editor.add({
          name: waitName,
          options: { codemode: false },
          description: waitDescription,
          input: WaitInput,
          output: WaitOutput,
          execute: wait,
        })
      })
      .pipe(Effect.asVoid)
  }),
}

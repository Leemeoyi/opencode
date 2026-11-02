export * as SubagentWaitTool from "./subagent-wait.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Ref, Schema } from "effect"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"

export const name = "subagent_wait"

const OUTPUT_LIMIT = 8000
const MAX_TIMEOUT = 3600

export const Input = Schema.Struct({
  sessionIDs: Schema.Array(SessionSchema.ID).annotate({
    description: "sessionIDs of subagents this session started with background=true",
  }),
  mode: Schema.optionalKey(Schema.Literals(["all", "any", "quorum"])).annotate({
    description:
      '"all" (default): wait until every subagent has finished. "any": return when the first one completes successfully. "quorum": return when count of them have completed successfully.',
  }),
  count: Schema.optionalKey(Schema.Number).annotate({ description: 'For "quorum": how many successful completions to wait for' }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: `Seconds to wait at most, up to ${MAX_TIMEOUT}. Default 600. On timeout, the results so far are returned.`,
  }),
  cancelRest: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Cancel the subagents still running when the wait ends. Default false.",
  }),
})

const Status = Schema.Literals(["running", "completed", "error", "cancelled"])

const Result = Schema.Struct({
  sessionID: Schema.String,
  description: Schema.String,
  status: Status,
  output: Schema.optionalKey(Schema.String),
})

export const Output = Schema.Struct({
  satisfied: Schema.Boolean,
  timedOut: Schema.Boolean,
  results: Schema.Array(Result),
})

export const description = [
  "Wait for background subagents started by this session: all of them, the first to succeed, or a quorum of successes.",
  "Returns each subagent's status and final response. Subagents that are still running keep running unless cancelRest is set.",
  "Use it after starting several subagents with background=true when you need their results before continuing, instead of ending your turn.",
  "You may still receive the usual completion notices for these subagents afterwards; ignore the ones whose results you already have.",
].join("\n")

type Outcome = { readonly status: Job.Status; readonly text?: string }

const clip = (text: string) =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[... ${text.length - OUTPUT_LIMIT} more characters]` : text

const fromJob = (info: Job.Info): Outcome => ({
  status: info.status,
  text: info.status === "completed" ? info.output : info.status === "error" ? info.error : undefined,
})

/**
 * A subagent that finished and delivered its result before the wait began no longer has a job; its own session still
 * holds its final reply.
 */
export const fromSession = (sessions: Pick<Session.Interface, "messages">, id: SessionSchema.ID) =>
  sessions.messages({ sessionID: id, order: "desc", limit: 20 }).pipe(
    Effect.map((messages): Outcome => {
      const assistant = messages.find((message) => message.type === "assistant" && message.time.completed !== undefined)
      if (assistant?.type === "assistant" && assistant.error === undefined)
        return { status: "completed", text: SubagentCompletion.text(assistant) }
      return { status: "error", text: "The subagent finished without a successful response." }
    }),
    Effect.mapError((error) => new ToolFailure({ message: `Could not read subagent session ${id}`, error })),
  )

export const Plugin = {
  id: "opencode.tool.subagent-wait",
  effect: Effect.fn("SubagentWaitTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const permission = yield* Permission.Service

    const outcome = Effect.fnUntraced(function* (id: SessionSchema.ID) {
      if ((yield* jobs.get(id)) === undefined) return yield* fromSession(sessions, id)
      const result = yield* jobs.wait({ id })
      if (result.info === undefined || result.info.status === "running") return yield* fromSession(sessions, id)
      return fromJob(result.info)
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const ids = [...new Set(input.sessionIDs)]
              if (ids.length === 0 || ids.length > 20)
                return yield* new ToolFailure({ message: "Give between 1 and 20 subagent sessionIDs." })
              const mode = input.mode ?? "all"
              const need = mode === "all" ? ids.length : mode === "any" ? 1 : Math.floor(input.count ?? 0)
              if (need < 1 || need > ids.length)
                return yield* new ToolFailure({
                  message: `quorum needs a count between 1 and ${ids.length}, the number of sessionIDs given.`,
                })
              const titles = yield* Effect.forEach(ids, (id) =>
                Effect.gen(function* () {
                  const child = yield* sessions
                    .get(id)
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent session not found: ${id}`, error })))
                  if (child.parentID !== context.sessionID)
                    return yield* new ToolFailure({ message: `Session ${id} is not a subagent of the current session` })
                  return child.title ?? id
                }),
              )
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: "Waiting for subagents was denied", error })))

              // Each subagent's wait records its outcome; the first moment the condition holds, or every subagent has
              // finished without it, ends the wait.
              const finished = yield* Ref.make(new Map<SessionSchema.ID, Outcome>())
              const settled = yield* Deferred.make<void>()
              const decide = (done: ReadonlyMap<SessionSchema.ID, Outcome>) => {
                if (done.size === ids.length) return true
                return mode !== "all" && [...done.values()].filter((item) => item.status === "completed").length >= need
              }
              const seconds = Math.min(MAX_TIMEOUT, Math.max(1, input.timeout ?? 600))
              const ended = yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* Effect.forEach(
                    ids,
                    (id) =>
                      outcome(id).pipe(
                        Effect.flatMap((result) => Ref.updateAndGet(finished, (done) => new Map(done).set(id, result))),
                        Effect.flatMap((done) => (decide(done) ? Deferred.succeed(settled, undefined) : Effect.void)),
                      ),
                    { concurrency: "unbounded", discard: true },
                  ).pipe(Effect.forkScoped({ startImmediately: true }))
                  return yield* Deferred.await(settled).pipe(Effect.timeoutOption(seconds * 1000))
                }),
              )
              const timedOut = ended._tag === "None"

              const done = yield* Ref.get(finished)
              const running = ids.filter((id) => !done.has(id))
              if (input.cancelRest) yield* Effect.forEach(running, (id) => jobs.cancel(id), { discard: true })
              const results = ids.map((id, index) => {
                const result = done.get(id)
                const status = result?.status ?? (input.cancelRest ? ("cancelled" as const) : ("running" as const))
                return {
                  sessionID: id,
                  description: titles[index],
                  status,
                  ...(result?.text === undefined ? {} : { output: clip(result.text) }),
                }
              })
              const successes = results.filter((result) => result.status === "completed").length
              const satisfied = mode === "all" ? running.length === 0 : successes >= need

              const heading = timedOut
                ? `Stopped waiting after ${seconds}s.`
                : satisfied
                  ? mode === "all"
                    ? "All subagents finished."
                    : `${successes} of ${ids.length} subagents completed successfully, meeting the ${mode === "any" ? "first success" : `quorum of ${need}`}.`
                  : `Every subagent finished, but only ${successes} completed successfully; ${need} were needed.`
              const content = [
                heading,
                ...results.map((result) =>
                  [
                    `<subagent sessionID="${result.sessionID}" state="${result.status}" description="${result.description}">`,
                    result.output ??
                      (result.status === "running"
                        ? "Still running."
                        : result.status === "cancelled"
                          ? "Cancelled before it finished."
                          : "No response."),
                    "</subagent>",
                  ].join("\n"),
                ),
              ].join("\n\n")
              return { output: { satisfied, timedOut, results }, content }
            }),
        }),
      )
      .pipe(Effect.asVoid)
  }),
}

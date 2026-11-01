import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { SubagentWaitTool } from "@opencode/core/tool/plugin/subagent-wait"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Children answer at once with a reply naming their title; "fail" in the title fails the run, "hang" never finishes.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentWaitTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        const title = (yield* store.get(sessionID))?.title ?? ""
        if (title.includes("hang")) return yield* Effect.never
        if (title.includes("fail")) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: `answer from ${title}` })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const pluginSupervisor = makeLocationNode({
  name: "test/subagent-wait-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(SubagentWaitTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [Agent.node, Config.node, Model.node, Permission.node, Session.node, Job.node, SubagentJob.node, Tool.node, PluginHooks.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Job.node, Session.node, SessionExecution.node, LocationServiceMap.node]),
    [
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(pluginSupervisor),
    ],
  ),
)

const Result = Schema.Struct({
  satisfied: Schema.Boolean,
  timedOut: Schema.Boolean,
  results: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      description: Schema.String,
      status: Schema.String,
      output: Schema.optionalKey(Schema.String),
    }),
  ),
})

/** A parent session with the subagent tools, and helpers to launch background children and wait for them. */
const setup = Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }) })
  const locations = yield* LocationServiceMap.Service
  const scope = locations.get(parent.location)
  yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(scope))
  yield* Agent.Service.use((agents) =>
    agents.transform((editor) => {
      editor.update(toolIdentity.agent, (agent) => {
        agent.mode = "primary"
        agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
      })
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.mode = "subagent"
        agent.model = childModel
      })
    }),
  ).pipe(Effect.provide(scope))
  const registry = yield* Tool.Service.pipe(Effect.provide(scope))
  const call = (name: string, input: unknown, sessionID = parent.id) =>
    executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: `call-${Math.random()}`, name, input } })
  const launch = (description: string, sessionID = parent.id) =>
    call(SubagentTool.name, { agent: "reviewer", description, prompt: "go", background: true }, sessionID).pipe(
      Effect.map((result) => Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(result.metadata).sessionID),
    )
  const wait = (input: Record<string, unknown>) => call(SubagentWaitTool.name, input)
  return { sessions, parent, launch, wait }
})

describe("SubagentWaitTool", () => {
  it.live("all: waits for every subagent and reports successes and failures", () =>
    Effect.gen(function* () {
      const { launch, wait } = yield* setup
      const ids = [yield* launch("alpha"), yield* launch("beta fail")]
      const result = yield* wait({ sessionIDs: ids })
      expect(result.status).toBe("completed")
      const output = Schema.decodeUnknownSync(Result)(result.output)
      expect(output.satisfied).toBe(true)
      expect(output.timedOut).toBe(false)
      expect(output.results.map((item) => [item.description, item.status])).toEqual([
        ["alpha", "completed"],
        ["beta fail", "error"],
      ])
      expect(output.results[0].output).toBe("answer from alpha")
    }).pipe(Effect.scoped),
  )

  it.live("any: returns on the first success while others are still running", () =>
    Effect.gen(function* () {
      const { launch, wait } = yield* setup
      const ids = [yield* launch("slow hang"), yield* launch("quick")]
      const output = Schema.decodeUnknownSync(Result)((yield* wait({ sessionIDs: ids, mode: "any", timeout: 30 })).output)
      expect(output.satisfied).toBe(true)
      expect(output.timedOut).toBe(false)
      expect(output.results.map((item) => item.status)).toEqual(["running", "completed"])
    }).pipe(Effect.scoped),
  )

  it.live("quorum: ends early when the quorum can no longer be met", () =>
    Effect.gen(function* () {
      const { launch, wait } = yield* setup
      const ids = [yield* launch("one"), yield* launch("two fail"), yield* launch("three fail")]
      const result = yield* wait({ sessionIDs: ids, mode: "quorum", count: 2, timeout: 30 })
      const output = Schema.decodeUnknownSync(Result)(result.output)
      expect(output.satisfied).toBe(false)
      expect(output.timedOut).toBe(false)
      expect(JSON.stringify(result.content)).toContain("only 1 completed successfully; 2 were needed")
    }).pipe(Effect.scoped),
  )

  it.live("timeout: returns what finished, and cancelRest cancels the rest", () =>
    Effect.gen(function* () {
      const { launch, wait } = yield* setup
      const ids = [yield* launch("done"), yield* launch("stuck hang")]
      const output = Schema.decodeUnknownSync(Result)((yield* wait({ sessionIDs: ids, timeout: 1, cancelRest: true })).output)
      expect(output.timedOut).toBe(true)
      expect(output.satisfied).toBe(false)
      expect(output.results.map((item) => item.status)).toEqual(["completed", "cancelled"])
      const jobs = yield* Job.Service
      // Cancelled jobs are dropped from the job list; what matters is that it no longer runs.
      expect((yield* jobs.get(ids[1]))?.status).not.toBe("running")
    }).pipe(Effect.scoped),
  )

  it.live("rejects bad input and subagents of other sessions", () =>
    Effect.gen(function* () {
      const { sessions, parent, launch, wait } = yield* setup
      const other = yield* sessions.create({ location: parent.location })
      const foreign = yield* launch("foreign", other.id)
      const own = yield* launch("own")
      const rejected = yield* wait({ sessionIDs: [foreign] })
      expect(rejected.status).toBe("error")
      expect(JSON.stringify(rejected)).toContain("is not a subagent of the current session")
      const badQuorum = yield* wait({ sessionIDs: [own], mode: "quorum", count: 3 })
      expect(JSON.stringify(badQuorum)).toContain("quorum needs a count between 1 and 1")
    }).pipe(Effect.scoped),
  )
})

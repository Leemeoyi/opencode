import { describe, expect } from "bun:test"
import { ToolFailure } from "@opencode/ai/effect"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { ToolBackground } from "@opencode/core/tool/plugin/tool-background"
import { Tool } from "@opencode/core/tool"
import type { Context } from "@opencode/plugin/effect/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

// A probe call named "...fail..." fails and "...hang..." never finishes; a name with a gate waits for it to open.
const gates = new Map<string, Deferred.Deferred<void>>()
const ProbePlugin = {
  id: "test.probe",
  effect: (ctx: Context) =>
    ctx.tool
      .transform((editor) =>
        editor.add({
          name: "probe",
          options: { codemode: false },
          description: "Test tool",
          input: Schema.Struct({ name: Schema.String, background: Schema.optionalKey(Schema.Boolean) }),
          execute: (input) =>
            Effect.gen(function* () {
              const gate = gates.get(input.name)
              if (gate) yield* Deferred.await(gate)
              if (input.name.includes("hang")) return yield* Effect.never
              if (input.name.includes("fail")) return yield* new ToolFailure({ message: `${input.name} failed` })
              if (input.background !== undefined) return { content: `background flag reached the tool` }
              return { content: `result of ${input.name}` }
            }),
        }),
      )
      .pipe(Effect.asVoid),
}

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const pluginSupervisor = makeLocationNode({
  name: "test/tool-background-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const register: Context["tool"]["hook"] = (name, callback) => hooks.register("tool", name, callback)
      yield* registerToolPlugin(ProbePlugin, {}, register)
      yield* registerToolPlugin(ToolBackground.Plugin, {}, register)
    }),
  ),
  deps: [Agent.node, Session.node, Job.node, Tool.node, PluginHooks.node],
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

const decodeWait = Schema.decodeUnknownSync(ToolBackground.WaitOutput)

const setup = (permissions: Agent.Info["permissions"] = []) =>
  Effect.gen(function* () {
    gates.clear()
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }) })
    const scope = (yield* LocationServiceMap.Service).get(session.location)
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(scope))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) =>
        editor.update(toolIdentity.agent, (agent) => {
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" }, ...permissions)
        }),
      ),
    ).pipe(Effect.provide(scope))
    const registry = yield* Tool.Service.pipe(Effect.provide(scope))
    const call = (name: string, input: unknown) =>
      executeTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${Math.random()}`, name, input },
      })
    const start = (name: string) =>
      call(ToolBackground.startName, { tool: "probe", input: { name }, description: name }).pipe(
        Effect.map((result) => {
          expect(result.status).toBe("completed")
          return Schema.decodeUnknownSync(ToolBackground.StartOutput)(result.output).jobID
        }),
      )
    const gate = (name: string) =>
      Deferred.make<void>().pipe(Effect.tap((deferred) => Effect.sync(() => gates.set(name, deferred))))
    // The first synthetic notice admitted to this session.
    const notice = Bus.Service.use((bus) =>
      bus.subscribe(SessionEvent.InboxEnqueued).pipe(
        Stream.filter((event) => event.data.sessionID === session.id && event.data.item.type === "synthetic"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      ),
    )
    return { call, start, gate, notice, wait: (input: Record<string, unknown>) => call(ToolBackground.waitName, input) }
  })

describe("ToolBackground", () => {
  it.live("start returns at once; all waits for every job and reports failures", () =>
    Effect.gen(function* () {
      const { start, gate, wait } = yield* setup()
      const open = yield* gate("alpha")
      const ids = [yield* start("alpha"), yield* start("beta fail")]
      const jobs = yield* Job.Service
      expect((yield* jobs.get(ids[0]))?.status).toBe("running")
      yield* Deferred.succeed(open, undefined)
      const output = decodeWait((yield* wait({ ids })).output)
      expect(output.satisfied).toBe(true)
      expect(output.timedOut).toBe(false)
      expect(output.results.map((item) => [item.description, item.status])).toEqual([
        ["alpha", "completed"],
        ["beta fail", "error"],
      ])
      expect(output.results[0].output).toBe("result of alpha")
      expect(output.results[1].output).toContain("beta fail failed")
    }).pipe(Effect.scoped),
  )

  it.live("any: returns on the first success while others still run", () =>
    Effect.gen(function* () {
      const { start, wait } = yield* setup()
      const ids = [yield* start("slow hang"), yield* start("quick")]
      const output = decodeWait((yield* wait({ ids, mode: "any", timeout: 30 })).output)
      expect(output.satisfied).toBe(true)
      expect(output.results.map((item) => item.status)).toEqual(["running", "completed"])
    }).pipe(Effect.scoped),
  )

  it.live("quorum: ends early when the quorum can no longer be met", () =>
    Effect.gen(function* () {
      const { start, wait } = yield* setup()
      const ids = [yield* start("one"), yield* start("two fail"), yield* start("three fail")]
      const result = yield* wait({ ids, mode: "quorum", count: 2, timeout: 30 })
      const output = decodeWait(result.output)
      expect(output.satisfied).toBe(false)
      expect(output.timedOut).toBe(false)
      expect(JSON.stringify(result.content)).toContain("only 1 completed successfully; 2 were needed")
    }).pipe(Effect.scoped),
  )

  it.live("timeout 0 checks once, and cancelRest cancels the rest", () =>
    Effect.gen(function* () {
      const { start, wait } = yield* setup()
      const ids = [yield* start("done"), yield* start("stuck hang")]
      // Let the quick job finish first, so the check sees it.
      expect(decodeWait((yield* wait({ ids: [ids[0]] })).output).satisfied).toBe(true)
      const output = decodeWait((yield* wait({ ids, timeout: 0, cancelRest: true })).output)
      expect(output.timedOut).toBe(true)
      expect(output.results.map((item) => item.status)).toEqual(["completed", "cancelled"])
      const jobs = yield* Job.Service
      expect((yield* jobs.get(ids[1]))?.status).not.toBe("running")
    }).pipe(Effect.scoped),
  )

  it.live("posts a notice for a job nobody waited for, but not for one a wait returned", () =>
    Effect.gen(function* () {
      const { start, gate, notice, wait } = yield* setup()
      const open = yield* gate("waited")
      const waited = yield* start("waited")
      yield* Effect.forkScoped(Deferred.succeed(open, undefined).pipe(Effect.delay("20 millis")))
      expect(decodeWait((yield* wait({ ids: [waited] })).output).satisfied).toBe(true)
      const first = yield* notice
      const unwaited = yield* start("unwaited")
      const item = yield* Fiber.join(first)
      expect(item._tag).toBe("Some")
      const text = JSON.stringify(item)
      expect(text).toContain(unwaited)
      expect(text).toContain("result of unwaited")
      expect(text).not.toContain(waited)
    }).pipe(Effect.scoped),
  )

  it.live("drops the started tool's own background flag", () =>
    Effect.gen(function* () {
      const { call, wait } = yield* setup()
      const started = yield* call(ToolBackground.startName, {
        tool: "probe",
        input: { name: "flagged", background: true },
      })
      const id = Schema.decodeUnknownSync(ToolBackground.StartOutput)(started.output).jobID
      expect(decodeWait((yield* wait({ ids: [id] })).output).results[0].output).toBe("result of flagged")
    }).pipe(Effect.scoped),
  )

  it.live("refuses nested starts, denied tools and unknown job IDs", () =>
    Effect.gen(function* () {
      const { call, wait } = yield* setup([{ action: "probe", resource: "*", effect: "deny" }])
      const nested = yield* call(ToolBackground.startName, { tool: ToolBackground.waitName, input: { ids: [] } })
      expect(JSON.stringify(nested)).toContain("cannot be started in the background")
      const denied = yield* call(ToolBackground.startName, { tool: "probe", input: { name: "x" } })
      expect(JSON.stringify(denied)).toContain('No tool named \\"probe\\" is available')
      const unknown = yield* wait({ ids: ["tool_nope"] })
      expect(unknown.status).toBe("error")
      expect(JSON.stringify(unknown)).toContain("Unknown job ID")
    }).pipe(Effect.scoped),
  )
})

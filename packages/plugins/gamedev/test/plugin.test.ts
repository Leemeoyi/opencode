import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { agentID } from "../index.ts"
import { detect } from "../src/detect.ts"

const fixture = path.join(import.meta.dir, "fixture", "web-game")

type Tool = {
  readonly name: string
  readonly execute: (input: unknown, context: { readonly signal: AbortSignal }) => Promise<{ output?: any; content?: any }>
}
type Agent = { name?: string; mode?: string; permissions: unknown[] }
type ContextEvent = { agent: string; system: { type: string; text: string }[] }

// Records what the plugin registers, standing in for the OpenCode plugin host.
const load = async (directory: string) => {
  const agents = new Map<string, Agent>()
  const tools = new Map<string, Tool>()
  const skills = new Map<string, { id: string }>()
  const contextHooks: ((event: ContextEvent) => void)[] = []
  const ctx = {
    location: { directory },
    options: {},
    agent: {
      transform: async (fn: (editor: unknown) => void) =>
        fn({
          update: (id: string, update: (agent: Agent) => void) => {
            const agent = agents.get(id) ?? { permissions: [] }
            agents.set(id, agent)
            update(agent)
          },
        }),
    },
    session: {
      hook: async (name: string, fn: (event: ContextEvent) => void) => {
        if (name === "context") contextHooks.push(fn)
      },
    },
    skill: {
      transform: async (fn: (editor: unknown) => void) =>
        fn({ get: (id: string) => skills.get(id), add: (skill: { id: string }) => skills.set(skill.id, skill) }),
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => fn({ add: (tool: Tool) => tools.set(tool.name, tool) }),
    },
  }
  await plugin.setup(ctx as never)
  return { agents, tools, skills, contextHooks }
}

const signal = () => new AbortController().signal

describe("detect", () => {
  test("finds a web game and its package manager", async () => {
    const project = await detect(fixture)
    expect(project?.engine).toBe("web")
    expect(project?.detail).toBe("Phaser 3.90.0")
    expect(project?.packageManager).toBe("bun")
  })

  test("finds Unreal, Unity and Godot projects", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamedev-detect-"))
    await writeFile(path.join(directory, "Shooter.uproject"), JSON.stringify({ EngineAssociation: "5.6" }))
    expect((await detect(directory))?.detail).toBe("Unreal Engine 5.6")
    await rm(path.join(directory, "Shooter.uproject"))

    await writeFile(
      path.join(directory, "project.godot"),
      'config/name="Platformer"\nconfig/features=PackedStringArray("4.4", "Forward Plus")\n',
    )
    const godot = await detect(directory)
    expect(godot?.name).toBe("Platformer")
    expect(godot?.detail).toBe("Godot 4.4")
    await rm(directory, { recursive: true })
  })

  test("ignores a web app without a game framework", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamedev-detect-"))
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }))
    expect(await detect(directory)).toBeUndefined()
    await rm(directory, { recursive: true })
  })
})

describe("plugin", () => {
  test("registers the agent, skill and web tools, and extends only its own agent's prompt", async () => {
    const loaded = await load(fixture)
    expect(loaded.agents.get(agentID)?.mode).toBe("primary")
    expect([...loaded.skills.keys()]).toEqual(["web-game"])
    expect([...loaded.tools.keys()].sort()).toEqual(["game_build", "game_playtest", "game_project"])

    const other = { agent: "build", system: [] as ContextEvent["system"] }
    const own = { agent: agentID, system: [] as ContextEvent["system"] }
    loaded.contextHooks.forEach((hook) => {
      hook(other)
      hook(own)
    })
    expect(other.system).toHaveLength(0)
    expect(own.system[0]?.text).toContain("game_playtest")
    expect(own.system[0]?.text).toContain("Phaser 3.90.0")
  })

  test("registers only game_project when no game is found", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamedev-empty-"))
    const loaded = await load(directory)
    expect([...loaded.tools.keys()]).toEqual(["game_project"])
    await rm(directory, { recursive: true })
  })

  test("game_build reports success and failure", async () => {
    const loaded = await load(fixture)
    const ok = await loaded.tools.get("game_build")!.execute({}, { signal: signal() })
    expect(ok.output.success).toBe(true)
    expect(ok.output.output).toContain("built 1 file")

    process.env.FIXTURE_BUILD_FAIL = "1"
    const failed = await loaded.tools
      .get("game_build")!
      .execute({}, { signal: signal() })
      .finally(() => delete process.env.FIXTURE_BUILD_FAIL)
    expect(failed.output.success).toBe(false)
    expect(failed.output.output).toContain("error TS2322")
  })

  test(
    "game_playtest starts the dev server, replays input, and reports errors, frame rate and a screenshot",
    async () => {
      const loaded = await load(fixture)
      const result = await loaded.tools.get("game_playtest")!.execute(
        {
          seconds: 2,
          actions: [
            { type: "hold", key: "ArrowRight", ms: 200 },
            { type: "press", key: "KeyE" },
          ],
        },
        { signal: signal() },
      )
      const errors: string[] = result.output.errors
      expect(result.output.url).toMatch(/^http:\/\/localhost:\d+\/$/)
      expect(result.output.fps).toBeGreaterThan(0)
      expect(errors.some((line) => line.includes("fixture: boom on E"))).toBe(true)
      expect(errors.some((line) => line.includes("missing-sprite.png"))).toBe(true)
      expect(result.output.warnings.some((line: string) => line.includes("fixture warning"))).toBe(true)
      const image = result.content.find((part: { type: string }) => part.type === "file")
      expect(image.mime).toBe("image/png")
      const png = Buffer.from(image.uri.replace("data:image/png;base64,", ""), "base64")
      expect(png.subarray(1, 4).toString()).toBe("PNG")
    },
    60_000,
  )
})

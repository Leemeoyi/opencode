import { Agent, Plugin, Skill } from "@opencode/plugin"
import { Schema } from "effect"
import matter from "gray-matter"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, detect } from "./src/detect.js"
import { system } from "./src/prompt.js"
import { register as registerUnreal } from "./src/tools/unreal.js"
import { register as registerWeb } from "./src/tools/web.js"
import { findEngine, mcpURL } from "./src/unreal.js"

export const agentID = "game-engineer"

const skills = { web: ["web-game"], unreal: ["unreal-cpp"], unity: [], godot: [] } as const

export default Plugin.define({
  id: "leemeoyi.gamedev",
  async setup(ctx) {
    const project = await detect(ctx.location.directory)
    const install = project?.engine === "unreal" ? await findEngine(project.engineAssociation) : undefined

    await ctx.agent.transform((editor) => {
      editor.update(agentID, (agent) => {
        agent.name = Agent.Name.make("Game Engineer")
        agent.description = "Builds, playtests and fixes games. Detects the engine and verifies changes by running the game."
        agent.mode = "primary"
        agent.color = "#a78bfa"
        agent.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })
    })

    // The agent keeps OpenCode's base system prompt; the game-engineer instructions are added to it.
    await ctx.session.hook("context", (event) => {
      if (event.agent !== agentID) return
      event.system.push({ type: "text", text: system(project, install) })
    })

    const directory = new URL("./skills/", import.meta.url)
    const loaded = await Promise.all(
      (project ? skills[project.engine] : []).map(async (name) => {
        const file = new URL(`${name}/SKILL.md`, directory)
        const markdown = matter(await readFile(file, "utf8"))
        return Skill.Info.make({
          id: Skill.ID.make(name),
          name: Skill.Name.make(markdown.data.name),
          description: markdown.data.description,
          autoinvoke: true,
          path: Skill.Info.fields.path.make(fileURLToPath(file)),
          content: markdown.content,
        })
      }),
    )
    await ctx.skill.transform((editor) => {
      loaded.forEach((skill) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
    })

    // The Unreal editor serves its own MCP tools while it runs. A reload only reconnects servers whose settings
    // changed, so a connection that failed while the editor was closed is retried by bumping a header value.
    const editorMcp = { generation: 0 }
    if (project?.engine === "unreal")
      await ctx.mcp.transform((editor) => {
        if (editor.get("unreal-editor")) return
        editor.set("unreal-editor", {
          type: "remote",
          url: mcpURL,
          oauth: false,
          headers: { "x-opencode-gamedev-generation": String(editorMcp.generation) },
        })
      })
    const reconnectEditor = async () => {
      editorMcp.generation++
      await ctx.mcp.reload()
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "game_project",
        options: { codemode: false },
        description: "Detect the game engine, version and project layout in the working directory.",
        input: Schema.Struct({}),
        output: Schema.Struct({ engine: Schema.optionalKey(Schema.String), summary: Schema.String }),
        execute: async () => {
          const current = await detect(ctx.location.directory)
          if (!current) {
            const summary = `No Unreal, Unity, Godot or web game project found in ${ctx.location.directory}`
            return { output: { summary }, content: summary }
          }
          const summary = describe(current)
          return { output: { engine: current.engine, summary }, content: summary }
        },
      })

      if (project?.engine === "web") registerWeb(tools, project)
      if (project?.engine === "unreal" && install) registerUnreal(tools, project, install, reconnectEditor)
    })
  },
})

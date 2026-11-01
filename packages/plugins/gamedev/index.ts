import { Agent, Plugin, Skill } from "@opencode/plugin"
import { Schema } from "effect"
import matter from "gray-matter"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, detect } from "./src/detect.js"
import { system } from "./src/prompt.js"
import { build, playtest, summarize } from "./src/web.js"

export const agentID = "game-engineer"

const skills = ["web-game"]

const Action = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("press"),
    key: Schema.String.annotate({ description: 'Key name, e.g. "Space", "ArrowLeft", "KeyR"' }),
  }),
  Schema.Struct({
    type: Schema.Literal("hold"),
    key: Schema.String,
    ms: Schema.Number.annotate({ description: "How long to hold the key, in milliseconds" }),
  }),
  Schema.Struct({
    type: Schema.Literal("click"),
    x: Schema.Number.annotate({ description: "X in canvas pixels" }),
    y: Schema.Number.annotate({ description: "Y in canvas pixels" }),
  }),
  Schema.Struct({ type: Schema.Literal("wait"), ms: Schema.Number }),
])

export default Plugin.define({
  id: "leemeoyi.gamedev",
  async setup(ctx) {
    const project = await detect(ctx.location.directory)

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
      event.system.push({ type: "text", text: system(project) })
    })

    const directory = new URL("./skills/", import.meta.url)
    const loaded = await Promise.all(
      skills.map(async (name) => {
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

      if (project?.engine !== "web") return

      tools.add({
        name: "game_build",
        options: { codemode: false },
        description: "Build the browser game with its package.json script and return the result and the end of the output.",
        input: Schema.Struct({
          script: Schema.optionalKey(Schema.String).annotate({ description: 'package.json script to run. Default "build".' }),
        }),
        output: Schema.Struct({ success: Schema.Boolean, exitCode: Schema.Number, output: Schema.String }),
        execute: async (input, context) => {
          const result = await build(project, input.script ?? "build", context.signal)
          return {
            output: result,
            content: `${result.success ? "Build succeeded" : `Build failed (exit ${result.exitCode})`}\n\n${result.output}`,
          }
        },
      })

      tools.add({
        name: "game_playtest",
        options: { codemode: false },
        description: [
          "Run the browser game in a headless browser and report what happened.",
          "Starts the project's dev server unless a url is given, replays the given key presses and clicks,",
          "and returns the frame rate, console errors and warnings, failed asset loads, and a screenshot.",
        ].join(" "),
        input: Schema.Struct({
          url: Schema.optionalKey(Schema.String).annotate({ description: "Test this URL instead of starting the dev server" }),
          path: Schema.optionalKey(Schema.String).annotate({
            description:
              'Page path and query to open on the dev server (or on url), e.g. "?speed=600" or "/level-2". Use this instead of starting a server yourself.',
          }),
          seconds: Schema.optionalKey(Schema.Number).annotate({
            description: "How long to observe the game after loading, 1-60. Default 5.",
          }),
          actions: Schema.optionalKey(Schema.Array(Action)).annotate({ description: "Inputs to replay, in order" }),
          probes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
            description: [
              "JavaScript expressions evaluated in the page once the game has loaded and again after the inputs,",
              'to measure game state, e.g. "window.__game.scene.scenes[0].ship.x".',
              "The game must expose what you read on window; add that in development code if it does not.",
            ].join(" "),
          }),
        }),
        output: Schema.Struct({
          url: Schema.String,
          fps: Schema.Number,
          errors: Schema.Array(Schema.String),
          warnings: Schema.Array(Schema.String),
          probes: Schema.Array(Schema.Struct({ expression: Schema.String, before: Schema.String, after: Schema.String })),
        }),
        execute: async (input, context) => {
          const report = await playtest(
            project,
            {
              url: input.url,
              path: input.path,
              seconds: Math.min(60, Math.max(1, input.seconds ?? 5)),
              actions: input.actions ?? [],
              probes: input.probes ?? [],
            },
            context.signal,
          )
          return {
            output: {
              url: report.url,
              fps: report.fps,
              errors: report.errors,
              warnings: report.warnings,
              probes: report.probes,
            },
            content: [
              { type: "text", text: summarize(report) },
              { type: "file", uri: `data:image/png;base64,${report.screenshot}`, mime: "image/png", name: "playtest.png" },
            ],
          }
        },
      })
    })
  },
})

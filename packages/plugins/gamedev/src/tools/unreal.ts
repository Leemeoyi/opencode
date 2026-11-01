import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import type { Project } from "../detect.js"
import {
  build,
  closeEditor,
  describeGroups,
  type Install,
  mcpReachable,
  mcpURL,
  openEditor,
  openedHere,
  playtest,
  readLog,
  test,
} from "../unreal.js"

const text = <Output,>(output: Output, content: string) => ({ output, content })

/** `reconnect` makes OpenCode connect to the editor's MCP server again once the editor is up. */
export const register = (tools: ToolEditor, project: Project, install: Install, reconnect: () => Promise<void>) => {
  tools.add({
    name: "game_build",
    options: { codemode: false },
    description: [
      "Compile the Unreal project's C++ with Unreal Build Tool and return the errors and warnings with file and line.",
      "Fails while the editor has Live Coding active; use Live Coding through the editor MCP tools then, or close the editor.",
    ].join(" "),
    input: Schema.Struct({
      target: Schema.optionalKey(Schema.Literals(["editor", "game"])).annotate({
        description: 'Default "editor": the <Project>Editor target the editor loads. "game" builds the standalone game.',
      }),
      configuration: Schema.optionalKey(Schema.Literals(["Development", "DebugGame", "Shipping"])).annotate({
        description: 'Default "Development".',
      }),
    }),
    output: Schema.Struct({
      success: Schema.Boolean,
      target: Schema.String,
      errors: Schema.Array(Schema.String),
      warnings: Schema.Array(Schema.String),
    }),
    execute: async (input, context) => {
      const result = await build(
        project,
        install,
        { target: input.target ?? "editor", configuration: input.configuration ?? "Development" },
        context.signal,
      )
      const summary = [
        `${result.success ? "Build succeeded" : `Build failed (exit ${result.exitCode})`}: ${result.target}`,
        `Errors (${result.errors.length}):`,
        ...(result.errors.length ? result.errors.slice(0, 40).map((line) => `  ${line}`) : ["  none"]),
        `Warnings (${result.warnings.length}):`,
        ...(result.warnings.length ? result.warnings.slice(0, 20).map((line) => `  ${line}`) : ["  none"]),
        ...(!result.success && result.errors.length === 0 ? ["", "End of the build output:", result.output] : []),
      ].join("\n")
      return text(
        { success: result.success, target: result.target, errors: result.errors, warnings: result.warnings },
        summary,
      )
    },
  })

  tools.add({
    name: "game_logs",
    options: { codemode: false },
    description: [
      "Read the project's latest Unreal log (Saved/Logs/<Project>.log, written by the editor, game runs and tests).",
      "Returns errors and warnings with repeated lines grouped and counted.",
    ].join(" "),
    input: Schema.Struct({
      severity: Schema.optionalKey(Schema.Literals(["error", "warning"])).annotate({
        description: '"error" for errors only, "warning" (default) for errors and warnings.',
      }),
      search: Schema.optionalKey(Schema.String).annotate({ description: "Only lines containing this text, e.g. a log category" }),
      limit: Schema.optionalKey(Schema.Number).annotate({ description: "Maximum groups to return. Default 40." }),
    }),
    output: Schema.Struct({ file: Schema.String, groups: Schema.Number }),
    execute: async (input) => {
      const log = await readLog(project, { severity: input.severity ?? "warning", search: input.search })
      const limit = Math.max(1, input.limit ?? 40)
      return text(
        { file: log.file, groups: log.groups.length },
        [
          `${log.file}: ${log.groups.length} distinct ${input.severity === "error" ? "errors" : "errors and warnings"}`,
          describeGroups(log.groups, limit) || "none",
          ...(log.groups.length > limit ? [`... ${log.groups.length - limit} more; narrow with search`] : []),
        ].join("\n"),
      )
    },
  })

  tools.add({
    name: "game_playtest",
    options: { codemode: false },
    description: [
      "Run the Unreal game headless (no rendering) for some seconds after its map loads, then stop it.",
      "Reports whether it loaded, how long loading took, whether it crashed or quit early, and the errors and warnings it logged.",
      "Use after gameplay C++ or Blueprint changes, once the editor target builds.",
    ].join(" "),
    input: Schema.Struct({
      map: Schema.optionalKey(Schema.String).annotate({
        description: 'Map to open, e.g. "/Game/Maps/LV_Intro". Default: the project\'s game default map.',
      }),
      seconds: Schema.optionalKey(Schema.Number).annotate({ description: "How long to run after the map loads, 1-300. Default 20." }),
      commands: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: 'Console commands to run at startup, e.g. ["stat unit", "god"].',
      }),
    }),
    output: Schema.Struct({
      loaded: Schema.Boolean,
      exitedEarly: Schema.Boolean,
      errors: Schema.Number,
      warnings: Schema.Number,
    }),
    execute: async (input, context) => {
      const result = await playtest(
        project,
        install,
        { map: input.map, seconds: Math.min(300, Math.max(1, input.seconds ?? 20)), commands: input.commands ?? [] },
        context.signal,
      )
      const errors = result.groups.filter((group) => group.severity === "error").length
      const warnings = result.groups.length - errors
      const state = [
        result.loaded ? `Map loaded after ${result.loadSeconds}s.` : "The map did not finish loading.",
        result.exitedEarly
          ? `The game exited on its own (exit code ${result.exitCode}); a non-zero code usually means a crash.`
          : "The game ran until it was stopped.",
      ].join(" ")
      return text(
        { loaded: result.loaded, exitedEarly: result.exitedEarly, errors, warnings },
        [
          state,
          `${errors} distinct errors, ${warnings} distinct warnings:`,
          describeGroups(result.groups, 40) || "none",
          ...(!result.loaded || result.exitedEarly ? ["", "End of the output:", result.output] : []),
        ].join("\n"),
      )
    },
  })

  tools.add({
    name: "game_test",
    options: { codemode: false },
    description: [
      "Run Unreal automation tests headless and report each test's result and failure messages.",
      "The filter matches the start of test paths, e.g. the project name or \"Project.Functional\".",
    ].join(" "),
    input: Schema.Struct({
      filter: Schema.String.annotate({ description: "Test path prefix to run" }),
    }),
    output: Schema.Struct({ passed: Schema.Number, failed: Schema.Number, total: Schema.Number }),
    execute: async (input, context) => {
      const result = await test(project, install, input.filter, context.signal)
      const lines = result.tests.flatMap((item) => [
        `  ${item.state === "Success" ? "PASS" : item.state.toUpperCase()} ${item.path} (${item.seconds}s)`,
        ...item.problems.map((problem) => `      ${problem}`),
      ])
      return text(
        { passed: result.passed, failed: result.failed, total: result.tests.length },
        [
          result.tests.length
            ? `${result.passed} passed, ${result.failed} failed, ${result.tests.length} total`
            : `No tests matched "${input.filter}" or the run produced no report.`,
          ...lines,
          ...(result.output ? ["", "End of the output:", result.output] : []),
        ].join("\n"),
      )
    },
  })

  tools.add({
    name: "game_editor",
    options: { codemode: false },
    description: [
      `Open, check or close the Unreal editor for this project. The editor serves the Unreal MCP tools at ${mcpURL};`,
      "open it before using them. Close only closes an editor this tool opened, and lets it ask about unsaved work.",
    ].join(" "),
    input: Schema.Struct({ action: Schema.Literals(["open", "status", "close"]) }),
    output: Schema.Struct({ state: Schema.String }),
    execute: async (input, context) => {
      if (input.action === "status") {
        const reachable = await mcpReachable()
        const state = reachable ? "running, MCP reachable" : "not running or MCP not started"
        const owner = openedHere(project) ? " This session opened it." : reachable ? " The user opened it; do not close it." : ""
        return text({ state }, `Unreal editor: ${state}.${owner}`)
      }
      if (input.action === "close") {
        const state = await closeEditor(project)
        const messages = {
          closed: "The editor closed.",
          "not opened by this session":
            "This session did not open the editor, so it was left running. Ask the user if it needs to close.",
          "still open":
            "The editor did not close within 2 minutes. It is probably showing a dialog, such as unsaved changes or shaders still compiling. Ask the user to close it; never force-kill it.",
        }
        return text({ state }, messages[state])
      }
      const result = await openEditor(project, install, context.signal)
      if (result.state === "opened" || result.state === "already running") await reconnect()
      const messages = {
        "already running": "The editor is already running and its MCP server is reachable.",
        opened: `The editor opened and its MCP server answered after ${result.waitedSeconds}s.`,
        exited: "The editor exited before its MCP server started. Check game_logs.",
        "no mcp": `The editor is running but its MCP server did not answer within ${result.waitedSeconds}s. The Unreal MCP plugin may be disabled or not set to start automatically.`,
      }
      return text({ state: result.state }, messages[result.state])
    },
  })
}

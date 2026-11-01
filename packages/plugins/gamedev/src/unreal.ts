import type { Subprocess } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Project } from "./detect.js"
import { clean, killTree, run, tail } from "./process.js"

export type Install = { readonly root: string; readonly version: string }

export const mcpURL = "http://localhost:8000/mcp"

const launcherList = "C:/ProgramData/Epic/UnrealEngineLauncher/LauncherInstalled.dat"

type LauncherEntry = { readonly AppName: string; readonly AppVersion?: string; readonly InstallLocation: string }

/** Finds the engine a .uproject asks for: a launcher install by version, or a source build registered by GUID. */
export const findEngine = async (association: string | undefined, list = launcherList): Promise<Install | undefined> => {
  if (!association || process.platform !== "win32") return undefined
  if (/^\{?[0-9A-F]{8}-[0-9A-F-]{27}\}?$/i.test(association)) {
    const result = await run({
      command: ["reg", "query", "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds", "/v", association],
      cwd: tmpdir(),
      signal: new AbortController().signal,
      timeout: 10_000,
    })
    const root = result.output.match(/REG_SZ\s+(.+)/)?.[1]?.trim()
    return root ? { root, version: association } : undefined
  }
  const installs: readonly LauncherEntry[] = await Bun.file(list)
    .json()
    .then((data) => data.InstallationList ?? [])
    .catch(() => [])
  const match = installs.find((entry) => entry.AppName === `UE_${association}`)
  if (!match) return undefined
  return { root: match.InstallLocation, version: match.AppVersion?.split("-")[0] ?? association }
}

const editorBinary = (install: Install, name: "UnrealEditor.exe" | "UnrealEditor-Cmd.exe") =>
  path.join(install.root, "Engine", "Binaries", "Win64", name)

const env = { ...process.env, UE_LOG_JSON_TO_STDOUT: "0" }

export type Diagnostic = { readonly severity: "error" | "warning"; readonly text: string }

const compileLine = /^\s*(.+?\.(?:cpp|h|hpp|inl|cs))\((\d+)(?:,\d+)?\)\s*:\s*(fatal error|error|warning)\s+(\w+)\s*:\s*(.+)$/

/** Compiler, linker and build-tool problems from Unreal Build Tool output, without repeats from parallel compiles. */
export const parseBuild = (output: string): Diagnostic[] => {
  const found = clean(output)
    .split("\n")
    .flatMap((line): Diagnostic[] => {
      const match = line.match(compileLine)
      if (match)
        return [
          { severity: match[3] === "warning" ? "warning" : "error", text: `${match[1]}:${match[2]} ${match[4]}: ${match[5]}` },
        ]
      if (/error LNK\d+|UnrealBuildTool.*: error|^\s*ERROR:|Live Coding is active/i.test(line))
        return [{ severity: "error", text: line.trim() }]
      return []
    })
  return [...new Map(found.map((item) => [item.text, item])).values()]
}

export const build = async (
  project: Project,
  install: Install,
  input: { readonly target: "editor" | "game"; readonly configuration: string },
  signal: AbortSignal,
) => {
  const target = input.target === "editor" ? `${project.name}Editor` : project.name
  const result = await run({
    command: [
      path.join(install.root, "Engine", "Binaries", "DotNET", "UnrealBuildTool", "UnrealBuildTool.exe"),
      target,
      "Win64",
      input.configuration,
      `-Project=${project.file}`,
      "-WaitMutex",
      "-NoHotReloadFromIDE",
    ],
    cwd: project.directory,
    signal,
    timeout: 60 * 60_000,
  })
  const diagnostics = parseBuild(result.output)
  return {
    success: result.code === 0,
    exitCode: result.code,
    target,
    errors: diagnostics.filter((item) => item.severity === "error").map((item) => item.text),
    warnings: diagnostics.filter((item) => item.severity === "warning").map((item) => item.text),
    output: tail(result.output, 40),
  }
}

/** The severity of an Unreal log line, or undefined when it is neither an error nor a warning. */
export const logSeverity = (line: string): Diagnostic["severity"] | undefined => {
  if (/: (?:Fatal error|Error):|Ensure condition failed|Assertion failed|Unhandled Exception/.test(line)) return "error"
  if (/: Warning:/.test(line)) return "warning"
  return undefined
}

export type LogGroup = { readonly severity: Diagnostic["severity"]; readonly count: number; readonly example: string }

/** Groups log lines that differ only in quoted names, GUIDs or numbers, keeping the first line as the example. */
export const groupLog = (
  text: string,
  filter: { readonly severity: "error" | "warning"; readonly search?: string },
): LogGroup[] => {
  const groups = new Map<string, { severity: Diagnostic["severity"]; count: number; example: string }>()
  clean(text)
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]*\]\[[^\]]*\]/, "").trim())
    .forEach((line) => {
      const severity = logSeverity(line)
      if (!severity || (filter.severity === "error" && severity !== "error")) return
      if (filter.search && !line.toLowerCase().includes(filter.search.toLowerCase())) return
      const key = line.replace(/'[^']*'|`[^`]*`|"[^"]*"|\b[0-9A-F]{16,}\b|\d+/gi, "#")
      const group = groups.get(key)
      if (group) return void group.count++
      groups.set(key, { severity, count: 1, example: line.length > 400 ? `${line.slice(0, 400)}...` : line })
    })
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
}

export const describeGroups = (groups: readonly LogGroup[], limit: number) =>
  groups
    .slice(0, limit)
    .map((group) => `${group.count > 1 ? `[x${group.count}] ` : ""}${group.example}`)
    .join("\n")

export const readLog = async (
  project: Project,
  filter: { readonly severity: "error" | "warning"; readonly search?: string },
) => {
  const file = path.join(project.directory, "Saved", "Logs", `${project.name}.log`)
  if (!(await Bun.file(file).exists())) throw new Error(`No log yet at ${file}. Run the editor, game or tests first.`)
  return { file, groups: groupLog(await Bun.file(file).text(), filter) }
}

// The map has loaded and the game world is running.
const worldReady = /LogLoad: Took .* to LoadMap|LogWorld: Bringing World .* up for play/

/**
 * Runs the game without rendering for a while after its map loads, then stops it, and reports the errors and warnings
 * it logged. This catches crashes, failed asserts and runtime errors that only show up in play.
 */
export const playtest = async (
  project: Project,
  install: Install,
  input: { readonly map?: string; readonly seconds: number; readonly commands: readonly string[] },
  signal: AbortSignal,
) => {
  const proc = Bun.spawn(
    [
      editorBinary(install, "UnrealEditor-Cmd.exe"),
      project.file!,
      ...(input.map ? [input.map] : []),
      "-game",
      "-nullrhi",
      "-unattended",
      "-nosplash",
      "-nosound",
      "-stdout",
      "-FullStdOutLogOutput",
      // Editor Python (toolset start-up scripts) fails without the editor and never runs in a shipped game.
      "-DisablePython",
      ...(input.commands.length ? [`-ExecCmds=${input.commands.join(";")}`] : []),
    ],
    { cwd: project.directory, stdout: "pipe", stderr: "pipe", env },
  )
  const chunks: string[] = []
  const decoder = new TextDecoder()
  const started = Date.now()
  const loaded = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5 * 60_000)
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true })
        chunks.push(text)
        if (!worldReady.test(text)) continue
        clearTimeout(timer)
        resolve(true)
      }
    }
    void read(proc.stdout)
    void read(proc.stderr)
    void proc.exited.then(() => {
      clearTimeout(timer)
      resolve(false)
    })
    signal.addEventListener("abort", () => resolve(false), { once: true })
  })
  const loadSeconds = Math.round((Date.now() - started) / 100) / 10
  const exitedEarly = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(loaded && !signal.aborted ? input.seconds * 1000 : 0).then(() => false),
  ])
  if (!exitedEarly) await killTree(proc.pid)
  const output = chunks.join("")
  return {
    loaded,
    loadSeconds,
    exitedEarly,
    exitCode: exitedEarly ? proc.exitCode : undefined,
    groups: groupLog(output, { severity: "warning" }),
    output: tail(output, 30),
  }
}

type AutomationEntry = { readonly event: { readonly type: string; readonly message: string } }
type AutomationTest = {
  readonly fullTestPath: string
  readonly state: string
  readonly duration?: number
  readonly entries?: readonly AutomationEntry[]
}

/** Runs automation tests whose path starts with the filter, headless, and reads the exported report. */
export const test = async (project: Project, install: Install, filter: string, signal: AbortSignal) => {
  const report = await mkdtemp(path.join(tmpdir(), "gamedev-ue-tests-"))
  const result = await run({
    command: [
      editorBinary(install, "UnrealEditor-Cmd.exe"),
      project.file!,
      `-ExecCmds=Automation RunTests ${filter}; Quit`,
      "-unattended",
      "-nopause",
      "-nullrhi",
      "-nosplash",
      "-nosound",
      "-stdout",
      `-ReportExportPath=${report}`,
    ],
    cwd: project.directory,
    signal,
    timeout: 45 * 60_000,
  })
  const index = await Bun.file(path.join(report, "index.json"))
    .text()
    .then((text) => JSON.parse(text.replace(/^\uFEFF/, "")) as { tests?: readonly AutomationTest[] })
    .catch(() => undefined)
    .finally(() => rm(report, { recursive: true, force: true }))
  const tests = (index?.tests ?? []).map((item) => ({
    path: item.fullTestPath,
    state: item.state,
    seconds: Math.round((item.duration ?? 0) * 10) / 10,
    problems: (item.entries ?? [])
      .filter((entry) => entry.event.type === "Error" || entry.event.type === "Warning")
      .map((entry) => `${entry.event.type}: ${entry.event.message}`)
      .slice(0, 10),
  }))
  return {
    exitCode: result.code,
    passed: tests.filter((item) => item.state === "Success").length,
    failed: tests.filter((item) => item.state === "Fail").length,
    tests,
    output: index ? "" : tail(result.output, 40),
  }
}

/** Whether the Unreal MCP server answers. Any HTTP response counts; a refused connection does not. */
export const mcpReachable = () =>
  fetch(mcpURL, { method: "GET", signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false)

// Editors this plugin opened, so it only ever closes its own.
const opened = new Map<string, Subprocess>()

export const openEditor = async (project: Project, install: Install, signal: AbortSignal) => {
  if (await mcpReachable()) return { state: "already running" as const, waitedSeconds: 0 }
  const proc = Bun.spawn([editorBinary(install, "UnrealEditor.exe"), project.file!], {
    cwd: project.directory,
    stdout: "ignore",
    stderr: "ignore",
    env,
  })
  opened.set(project.file!, proc)
  const started = Date.now()
  const ready = async (): Promise<boolean> => {
    if (signal.aborted || proc.exitCode !== null) return false
    if (await mcpReachable()) return true
    if (Date.now() - started > 10 * 60_000) return false
    await Bun.sleep(3000)
    return ready()
  }
  const reachable = await ready()
  const waitedSeconds = Math.round((Date.now() - started) / 1000)
  if (reachable) return { state: "opened" as const, waitedSeconds }
  if (proc.exitCode !== null) return { state: "exited" as const, waitedSeconds }
  return { state: "no mcp" as const, waitedSeconds }
}

/** Whether this session opened the project's editor and it is still running. */
export const openedHere = (project: Project) => opened.get(project.file!)?.exitCode === null

export const closeEditor = async (project: Project, wait = 120_000) => {
  const proc = opened.get(project.file!)
  if (!proc || proc.exitCode !== null) return "not opened by this session" as const
  // Close the main window, as clicking its X does, never a forced kill: the editor may hold unsaved work. It ignores
  // `taskkill` without /F, and does not respond while busy, for example compiling shaders, so allow it time.
  await Bun.spawn(
    ["powershell", "-NoProfile", "-Command", `(Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue).CloseMainWindow()`],
    { stdout: "ignore", stderr: "ignore" },
  ).exited
  const closed = await Promise.race([proc.exited.then(() => true), Bun.sleep(wait).then(() => false)])
  if (!closed) return "still open" as const
  opened.delete(project.file!)
  return "closed" as const
}

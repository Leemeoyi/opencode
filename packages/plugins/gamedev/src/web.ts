import type { Project } from "./detect.js"
import { clean, executable, killTree, run, tail } from "./process.js"

export type Action =
  | { readonly type: "press"; readonly key: string }
  | { readonly type: "hold"; readonly key: string; readonly ms: number }
  | { readonly type: "click"; readonly x: number; readonly y: number }
  | { readonly type: "wait"; readonly ms: number }

export type PlaytestReport = {
  readonly url: string
  readonly fps: number
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly logs: readonly string[]
  readonly screenshot: string
}

const localURL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?\S*/

// Counts animation frames so the playtest can report a frame rate without touching the game's code.
const frameCounter = `
  window.__gamedevFrames = 0
  const tick = () => { window.__gamedevFrames++; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
`

export const build = async (project: Project, script: string, signal: AbortSignal) => {
  if (!project.scripts?.[script]) throw new Error(`No "${script}" script in package.json`)
  const result = await run({
    command: [executable(project.packageManager ?? "npm"), "run", script],
    cwd: project.directory,
    signal,
    timeout: 10 * 60_000,
  })
  return { success: result.code === 0, exitCode: result.code, output: tail(result.output, 150) }
}

const serverScript = (project: Project) => ["dev", "start", "preview"].find((name) => project.scripts?.[name])

/** Starts the project's dev server and resolves with the first local URL it prints. */
const startServer = async (project: Project, script: string) => {
  const proc = Bun.spawn([executable(project.packageManager ?? "npm"), "run", script], {
    cwd: project.directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
    detached: process.platform !== "win32",
  })
  const chunks: string[] = []
  const decoder = new TextDecoder()
  const url = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30_000)
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        chunks.push(decoder.decode(chunk, { stream: true }))
        const match = clean(chunks.join("")).match(localURL)
        if (!match) continue
        clearTimeout(timer)
        resolve(match[0])
      }
    }
    void read(proc.stdout)
    void read(proc.stderr)
    void proc.exited.then(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
  return { url, stop: () => killTree(proc.pid), log: () => tail(chunks.join(""), 40) }
}

const launchBrowser = async () => {
  const { chromium } = await import("playwright-core")
  // Prefer browsers already installed on the machine so no download is needed.
  const attempt = async (channels: readonly (string | undefined)[]): Promise<Awaited<ReturnType<typeof chromium.launch>>> => {
    const channel = channels[0]
    const rest = channels.slice(1)
    return chromium.launch({ headless: true, channel }).catch((error) => {
      if (rest.length === 0) throw error
      return attempt(rest)
    })
  }
  return attempt(["msedge", "chrome", undefined])
}

export const playtest = async (
  project: Project,
  input: { readonly url?: string; readonly seconds: number; readonly actions: readonly Action[] },
  signal: AbortSignal,
): Promise<PlaytestReport> => {
  const script = serverScript(project)
  if (!input.url && !script) throw new Error('No URL given and no "dev", "start" or "preview" script to start a server')
  const server = input.url ? undefined : await startServer(project, script!)
  if (server && !server.url) {
    await server.stop()
    throw new Error(`The "${script}" script did not print a local URL within 30 seconds. Output:\n${server.log()}`)
  }
  const url = input.url ?? server!.url!
  const browser = await launchBrowser()
  const stop = () => void browser.close()
  signal.addEventListener("abort", stop, { once: true })

  const errors: string[] = []
  const warnings: string[] = []
  const logs: string[] = []
  return Promise.resolve()
    .then(async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      page.on("console", (message) => {
        const where = message.location().url
        // Browsers request /favicon.ico on their own; a missing one is not a game bug.
        if (message.type() === "error" && where.endsWith("/favicon.ico")) return
        const source = where && message.type() !== "log" ? ` (${where})` : ""
        const text = `[console.${message.type()}] ${message.text()}${source}`
        if (message.type() === "error") return void errors.push(text)
        if (message.type() === "warning") return void warnings.push(text)
        if (logs.length < 50) logs.push(text)
      })
      page.on("pageerror", (error) => errors.push(`[uncaught] ${error.stack ?? error.message}`))
      page.on("requestfailed", (request) =>
        errors.push(`[request failed] ${request.url()}: ${request.failure()?.errorText ?? "unknown error"}`),
      )
      await page.addInitScript(frameCounter)
      await page.goto(url, { waitUntil: "load", timeout: 30_000 })
      await page.waitForTimeout(1000)

      const canvas = page.locator("canvas").first()
      const box = (await canvas.count()) > 0 ? await canvas.boundingBox() : null
      const startFrames = Number(await page.evaluate("window.__gamedevFrames"))
      const started = Date.now()
      for (const action of input.actions) {
        if (action.type === "press") await page.keyboard.press(action.key)
        if (action.type === "hold") {
          await page.keyboard.down(action.key)
          await page.waitForTimeout(action.ms)
          await page.keyboard.up(action.key)
        }
        if (action.type === "click") await page.mouse.click((box?.x ?? 0) + action.x, (box?.y ?? 0) + action.y)
        if (action.type === "wait") await page.waitForTimeout(action.ms)
      }
      const remaining = input.seconds * 1000 - (Date.now() - started)
      if (remaining > 0) await page.waitForTimeout(remaining)
      const frames = Number(await page.evaluate("window.__gamedevFrames")) - startFrames
      const fps = Math.round((frames / ((Date.now() - started) / 1000)) * 10) / 10
      const image = box ? await canvas.screenshot({ type: "png" }) : await page.screenshot({ type: "png" })
      return { url, fps, errors, warnings, logs, screenshot: image.toString("base64") }
    })
    .finally(async () => {
      signal.removeEventListener("abort", stop)
      await browser.close()
      await server?.stop()
    })
}

export const summarize = (report: PlaytestReport) =>
  [
    `Playtested ${report.url}`,
    `Frame rate: ${report.fps} fps (headless browser; real hardware may differ)`,
    `Errors (${report.errors.length}):`,
    ...(report.errors.length ? report.errors.map((line) => `  ${line}`) : ["  none"]),
    `Warnings (${report.warnings.length}):`,
    ...(report.warnings.length ? report.warnings.slice(0, 20).map((line) => `  ${line}`) : ["  none"]),
    ...(report.logs.length ? ["Console:", ...report.logs.slice(0, 20).map((line) => `  ${line}`)] : []),
    "A screenshot of the game is attached.",
  ].join("\n")

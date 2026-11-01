import type { PackageManager } from "./detect.js"

/** The package manager's executable, resolved so Windows `.cmd` shims such as `npm.cmd` start too. */
export const executable = (manager: PackageManager) =>
  manager === "bun" ? process.execPath : (Bun.which(manager) ?? manager)

/** Stops a process and every child it started, such as the server a `dev` script launches. */
export const killTree = async (pid: number) => {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
    return
  }
  process.kill(-pid, "SIGTERM")
}

// oxlint-disable-next-line no-control-regex -- matches ANSI color codes in tool output
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g

export const clean = (text: string) => text.replace(ansi, "").replace(/\r\n/g, "\n")

/** Keeps the last `limit` lines, where build errors and summaries usually are. */
export const tail = (text: string, limit: number) => {
  const lines = clean(text).trimEnd().split("\n")
  if (lines.length <= limit) return lines.join("\n")
  return [`... ${lines.length - limit} earlier lines omitted`, ...lines.slice(-limit)].join("\n")
}

export const run = async (input: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeout: number
}) => {
  const proc = Bun.spawn([...input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
    detached: process.platform !== "win32",
  })
  const stop = () => void killTree(proc.pid)
  const timer = setTimeout(stop, input.timeout)
  input.signal.addEventListener("abort", stop, { once: true })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", stop)
  })
  return { code, output: [stdout, stderr].filter((part) => part.trim().length > 0).join("\n") }
}

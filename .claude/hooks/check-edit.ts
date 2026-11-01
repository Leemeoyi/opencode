// PostToolUse hook for Edit|Write: lints the edited file and type-checks its package.
// Usage: bun .claude/hooks/check-edit.ts <lint|typecheck>
// Exit 2 with problems on stderr feeds them back to Claude; exit 0 means clean or not applicable.
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const mode = process.argv[2]
const input = await Bun.stdin.json()
const file = path.resolve(input.tool_input?.file_path ?? "")

if (!/\.(ts|tsx)$/.test(file) || !file.startsWith(path.join(root, "packages") + path.sep)) process.exit(0)

const findPackage = async (dir: string): Promise<string | undefined> => {
  if (dir === root || dir === path.dirname(dir)) return undefined
  if (await Bun.file(path.join(dir, "package.json")).exists()) return dir
  return findPackage(path.dirname(dir))
}

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, output: (stdout + stderr).trim() }
}

const report = (title: string, output: string) => {
  const lines = output.split("\n")
  const shown = lines.slice(0, 60).join("\n")
  console.error(`${title}\n${shown}${lines.length > 60 ? `\n... ${lines.length - 60} more lines` : ""}`)
  process.exit(2)
}

if (mode === "lint") {
  const result = await run([process.execPath, "x", "oxlint", file], root)
  if (result.code !== 0) report(`oxlint found problems in ${path.relative(root, file)}:`, result.output)
  process.exit(0)
}

if (mode === "typecheck") {
  const pkg = await findPackage(path.dirname(file))
  if (!pkg) process.exit(0)
  const manifest = await Bun.file(path.join(pkg, "package.json")).json()
  if (!manifest.scripts?.typecheck) process.exit(0)
  const result = await run([process.execPath, "run", "typecheck"], pkg)
  if (result.code !== 0) report(`Type errors in ${path.relative(root, pkg)} after editing ${path.relative(root, file)}:`, result.output)
  process.exit(0)
}

import { readdir } from "node:fs/promises"
import path from "node:path"

export type Engine = "unreal" | "unity" | "godot" | "web"

export type Project = {
  readonly engine: Engine
  readonly directory: string
  readonly name: string
  /** Engine and version, or the web framework, for prompts and tool output. */
  readonly detail: string
  readonly packageManager?: PackageManager
  readonly scripts?: Readonly<Record<string, string>>
}

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

const webFrameworks = [
  ["phaser", "Phaser"],
  ["three", "Three.js"],
  ["@babylonjs/core", "Babylon.js"],
  ["pixi.js", "PixiJS"],
  ["excalibur", "Excalibur"],
  ["kaplay", "KAPLAY"],
  ["kaboom", "Kaboom"],
  ["playcanvas", "PlayCanvas"],
] as const

const lockfiles = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
] as const

export const detect = async (directory: string): Promise<Project | undefined> => {
  const entries = await readdir(directory).catch(() => [] as string[])

  const uproject = entries.find((entry) => entry.endsWith(".uproject"))
  if (uproject) {
    const info = await Bun.file(path.join(directory, uproject))
      .json()
      .catch(() => ({}))
    return {
      engine: "unreal",
      directory,
      name: path.basename(uproject, ".uproject"),
      detail: info.EngineAssociation ? `Unreal Engine ${info.EngineAssociation}` : "Unreal Engine",
    }
  }

  const unity = Bun.file(path.join(directory, "ProjectSettings", "ProjectVersion.txt"))
  if (await unity.exists()) {
    const version = (await unity.text()).match(/m_EditorVersion:\s*(\S+)/)?.[1]
    return {
      engine: "unity",
      directory,
      name: path.basename(directory),
      detail: version ? `Unity ${version}` : "Unity",
    }
  }

  if (entries.includes("project.godot")) {
    const text = await Bun.file(path.join(directory, "project.godot")).text()
    const version = text.match(/config\/features=PackedStringArray\("(\d+\.\d+)/)?.[1]
    return {
      engine: "godot",
      directory,
      name: text.match(/config\/name="([^"]*)"/)?.[1] ?? path.basename(directory),
      detail: version ? `Godot ${version}` : "Godot",
    }
  }

  if (!entries.includes("package.json")) return undefined
  const pkg = await Bun.file(path.join(directory, "package.json"))
    .json()
    .catch(() => ({}))
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  const framework = webFrameworks.find((entry) => dependencies[entry[0]] !== undefined)
  if (!framework) return undefined
  return {
    engine: "web",
    directory,
    name: pkg.name ?? path.basename(directory),
    detail: `${framework[1]} ${dependencies[framework[0]]}`,
    packageManager: lockfiles.find((entry) => entries.includes(entry[0]))?.[1] ?? "npm",
    scripts: pkg.scripts ?? {},
  }
}

export const describe = (project: Project) =>
  [
    `Project: ${project.name} (${project.detail})`,
    `Directory: ${project.directory}`,
    ...(project.packageManager ? [`Package manager: ${project.packageManager}`] : []),
    ...(project.scripts && Object.keys(project.scripts).length > 0
      ? [`Scripts: ${Object.entries(project.scripts).map((entry) => `${entry[0]} (${entry[1]})`).join(", ")}`]
      : []),
  ].join("\n")

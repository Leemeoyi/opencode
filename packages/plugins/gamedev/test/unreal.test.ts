import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { detect } from "../src/detect.ts"
import { findEngine, groupLog, parseBuild } from "../src/unreal.ts"

describe("parseBuild", () => {
  test("extracts compiler, linker and tool errors once each", () => {
    const output = [
      "[1/4] Compile [x64] Drifter.cpp",
      "F:\\Prj\\Drifter\\Source\\Drifter\\Drifter.cpp(12): error C2065: 'Speed': undeclared identifier",
      "F:\\Prj\\Drifter\\Source\\Drifter\\Drifter.cpp(12): error C2065: 'Speed': undeclared identifier",
      "F:\\Prj\\Drifter\\Source\\Drifter\\AI\\Brain.h(40,5): warning C4996: 'Old': was declared deprecated",
      "Module.Drifter.cpp.obj : error LNK2019: unresolved external symbol UFoo::Bar",
      "Unable to build while Live Coding is active. Exit the editor and game, or press Ctrl+Alt+F11 if iterating on code in the editor or game",
    ].join("\r\n")
    const result = parseBuild(output)
    expect(result).toEqual([
      { severity: "error", text: "F:\\Prj\\Drifter\\Source\\Drifter\\Drifter.cpp:12 C2065: 'Speed': undeclared identifier" },
      { severity: "warning", text: "F:\\Prj\\Drifter\\Source\\Drifter\\AI\\Brain.h:40 C4996: 'Old': was declared deprecated" },
      { severity: "error", text: "Module.Drifter.cpp.obj : error LNK2019: unresolved external symbol UFoo::Bar" },
      {
        severity: "error",
        text: "Unable to build while Live Coding is active. Exit the editor and game, or press Ctrl+Alt+F11 if iterating on code in the editor or game",
      },
    ])
  })
})

describe("groupLog", () => {
  const log = [
    "[2026.08.19-18.21.13:146][  0]LogWorldPartition: Warning: Invalid class for actor guid `773D2E58` ('BP_Civvy_C_1') from package '/Game/A'",
    "[2026.08.19-18.21.13:147][  0]LogWorldPartition: Warning: Invalid class for actor guid `11AA22BB` ('BP_Civvy_C_2') from package '/Game/B'",
    "[2026.08.19-18.21.14:000][ 12]LogTemp: Display: Spawned 3 drifters",
    "[2026.08.19-18.21.15:000][ 40]LogScript: Error: Script Msg: Accessed None trying to read property Target",
    "[2026.08.19-18.21.16:000][ 41]LogOutputDevice: Error: Ensure condition failed: Health > 0",
  ].join("\n")

  test("groups repeats and puts errors first", () => {
    const groups = groupLog(log, { severity: "warning" })
    expect(groups.map((group) => [group.severity, group.count])).toEqual([
      ["error", 1],
      ["error", 1],
      ["warning", 2],
    ])
    expect(groups[2].example).toStartWith("LogWorldPartition: Warning: Invalid class for actor guid `773D2E58`")
  })

  test("filters by severity and search text", () => {
    expect(groupLog(log, { severity: "error" })).toHaveLength(2)
    expect(groupLog(log, { severity: "warning", search: "logscript" }).map((group) => group.example)).toEqual([
      "LogScript: Error: Script Msg: Accessed None trying to read property Target",
    ])
  })
})

describe("findEngine", () => {
  test.skipIf(process.platform !== "win32")("reads launcher installs by version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamedev-ue-"))
    const list = path.join(directory, "LauncherInstalled.dat")
    await writeFile(
      list,
      JSON.stringify({
        InstallationList: [
          { AppName: "UE_5.6", AppVersion: "5.6.1-123+++UE5", InstallLocation: "D:\\Epic\\UE_5.6" },
          { AppName: "Fortnite", InstallLocation: "D:\\Fortnite" },
        ],
      }),
    )
    expect(await findEngine("5.6", list)).toEqual({ root: "D:\\Epic\\UE_5.6", version: "5.6.1" })
    expect(await findEngine("5.9", list)).toBeUndefined()
    await rm(directory, { recursive: true })
  })
})

describe("detect", () => {
  test("records the .uproject file and engine association", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamedev-ue-"))
    await writeFile(path.join(directory, "Racer.uproject"), JSON.stringify({ EngineAssociation: "5.8" }))
    const project = await detect(directory)
    expect(project).toMatchObject({ engine: "unreal", name: "Racer", engineAssociation: "5.8" })
    expect(project?.file).toBe(path.join(directory, "Racer.uproject"))
    await rm(directory, { recursive: true })
  })
})

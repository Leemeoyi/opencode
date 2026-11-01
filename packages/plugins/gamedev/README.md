# Game dev

An opt-in OpenCode plugin that adds a **Game Engineer** agent. It detects the project's engine and gives the agent tools to build the game and check its changes by running it. This plugin is part of the Leemeoyi/opencode fork and is not made by the OpenCode team.

## What it adds

| Piece | What it does |
| ----- | ------------ |
| Game Engineer agent | A primary agent (switch to it with `Tab`). It keeps OpenCode's normal coding prompt and adds game-engineering instructions for the detected engine. |
| `game_project` tool | Reports the engine, version, package manager and scripts. |
| `game_build` tool | Web: runs the `build` script (or another script) and returns the result and the end of the output. |
| `game_playtest` tool | Web: starts the dev server, opens the game in headless Edge or Chrome, replays key presses and clicks, and returns the frame rate, console errors and warnings, failed asset loads and a screenshot. |
| `web-game` skill | Browser game guidance: game loop, input, assets and performance. |

Web `game_playtest` also takes `probes` (JavaScript expressions read before and after the inputs, to measure game state) and `path` (a page path and query to open on the dev server it starts). It uses a browser already installed on the machine (Edge, then Chrome), so nothing is downloaded.

### Unreal Engine (Windows)

The plugin finds the engine the `.uproject` asks for, from the Epic launcher's install list or a registered source build.

| Tool | What it does |
| ---- | ------------ |
| `game_build` | Compiles the editor (default) or game target with Unreal Build Tool and returns errors and warnings with file and line. |
| `game_logs` | Reads `Saved/Logs/<Project>.log` and groups repeated errors and warnings. |
| `game_playtest` | Runs the game headless (`-game -nullrhi -DisablePython`) for some seconds after its map loads, then reports load time, crashes and logged errors. |
| `game_test` | Runs automation tests by path prefix and reads the exported report. |
| `game_editor` | Opens the editor and waits for its MCP server, checks status, or closes an editor it opened by closing its main window (never a forced kill). |
| `unreal-cpp` skill | Reflection, object lifetime, build errors, GAS, replication and modules. |

The plugin registers the editor's MCP server (`unreal-editor`, `http://localhost:8000/mcp`). To use it, enable the engine's experimental **Unreal MCP** plugin (`ModelContextProtocol`) and the toolsets you want (for example `EditorToolset`, `LiveCodingToolset`, `AutomationTestToolset`) in the project, restricted to the Editor target, and start the server with the editor:

```ini
; Config/DefaultEditorPerProjectUserSettings.ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
```

Avoid the `AllToolsets` plugin: it pulls in Game Features, MetaHuman and other plugins whose errors show up in every playtest.

Detected engines: Unreal (`*.uproject`), Unity (`ProjectSettings/ProjectVersion.txt`), Godot (`project.godot`) and browser games (`package.json` with Phaser, Three.js, Babylon.js, PixiJS, Excalibur, KAPLAY, Kaboom or PlayCanvas). Unity and Godot get the agent and detection only so far.

## Install

From Git:

```sh
opencode plugin add 'git+https://github.com/Leemeoyi/opencode.git#path:packages/plugins/gamedev'
```

For local development, add the directory to `plugins` in the game project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["F:/Claude/OpenCode/packages/plugins/gamedev"],
}
```

Start OpenCode in the game's directory. The engine is detected once when the plugin loads, so restart OpenCode after creating a new project in that directory.

## Develop

```sh
bun run typecheck
bun test
```

The tests use a small fixture game in `test/fixture/web-game` and need Edge or Chrome installed.

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

Detected engines: Unreal (`*.uproject`), Unity (`ProjectSettings/ProjectVersion.txt`), Godot (`project.godot`) and browser games (`package.json` with Phaser, Three.js, Babylon.js, PixiJS, Excalibur, KAPLAY, Kaboom or PlayCanvas). Build and playtest tools exist for browser games so far; Unreal, Unity and Godot get the agent and detection only.

The playtest uses a browser already installed on the machine (Edge, then Chrome), so nothing is downloaded.

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

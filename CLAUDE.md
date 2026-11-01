@AGENTS.md

# Leemeoyi/opencode fork

This is a personal fork of anomalyco/opencode. The rules in AGENTS.md (imported above) still apply. This file adds what is specific to the fork.

## Goal

Turn OpenCode into a harness for **game development** first, and general development later.

## Remotes

- `origin` is github.com/Leemeoyi/opencode, the fork. Push work here.
- `upstream` is github.com/anomalyco/opencode. Fetch and merge from it. Pushing to it is disabled on purpose; never re-enable it.
- The default branch is `dev`. Keep `dev` mergeable with `upstream/dev`.

## How to make changes

Upstream ships many commits a day, so every edit to an upstream file is a future merge conflict.

1. Prefer config (`opencode.jsonc`), `.opencode/command/`, `.opencode/skills/`, or a plugin over editing upstream code.
2. Put fork-only code in new files and packages, under `packages/plugins/<name>/` for plugins. A new file never conflicts.
3. When an upstream file must change, keep the edit small, and add it to the "Upstream edits" list below with the reason.
4. Never touch `packages/console`, `packages/stats`, `infra/`, `sst.config.ts` or `services/`. They are upstream's hosted service.

## Repo map

- Built-in plugins are registered in `packages/core/src/plugin/internal.ts` (`pre` and `post` lists).
- Agents (Build, Plan, Explore, title, summary): `packages/core/src/plugin/agent.ts`.
- System prompt per model family: `packages/core/src/plugin/system-prompt/*.txt`.
- Tools, one file each: `packages/core/src/tool/plugin/`. `todo.ts` is the smallest template.
- Tool loop: `packages/ai/src/loop.ts` and `packages/ai/src/tool-runtime.ts`.
- Providers: `packages/core/src/plugin/provider/` (wiring) and `packages/ai/src/providers/` (protocols).
- Plugin API: `packages/plugin/src/README.md`, with Effect hook types in `packages/plugin/src/effect/`.

## Planned work

### Context management instead of compaction

Goal: sessions that run for thousands of turns without summarizing, by building each request's context from a memory system instead.

- Compaction lives in `packages/core/src/session/compaction.ts`, with settings `auto`, `buffer`, `keep` and `precompute`. `compaction.auto: false` in config turns automatic compaction off.
- The `context` session hook (`SessionHooks.context` in `packages/plugin/src/effect/session.ts`) lets a plugin rewrite `system` and `messages` before every model request. This is the main place to plug in memory-backed context.
- The `compaction` hook can set `result` to supply its own summary and skip the model call. This is a fallback for when the provider rejects the context as too long (`reason: "overflow"`).
- Start with a plugin. Only edit `compaction.ts` if the hooks turn out not to be enough.

### Async tools and subagent dispatch

Goal: agents launch N subagents and wait for any, all, or a quorum of them.

- Background subagents already exist: `subagent` with `background: true` (`packages/core/src/tool/plugin/subagent.ts`). Completion is delivered as a notice (`session/subagent-job.ts`, `session/subagent-completion.ts`).
- `Job.Service` (`packages/core/src/job.ts`) already has `wait`, `background`, `cancel` and `runningBackground`. What is missing is a tool that lets an agent call them: wait for any, all, or K of N job IDs, with a timeout.
- Making every tool async (not only subagents and shell) touches the tool loop in `packages/ai`. That is a larger upstream edit. Design it before writing it.

### Game development

The harness acts as a **game engineer**. Unreal Engine is the main target; Unity, Godot and web game frameworks are supported too.

- Build it as an opt-in plugin in `packages/plugins/gamedev/`, modelled on `packages/plugins/figma/` (an MCP server plus skills, about 40 lines). It installs from a Git URL (`git+https://github.com/Leemeoyi/opencode.git#path:packages/plugins/gamedev`), or locally through `"plugins": ["./packages/plugins/gamedev"]` in `opencode.jsonc`.
- Detect the engine from the project: `*.uproject` (Unreal), `ProjectSettings/ProjectVersion.txt` (Unity), `project.godot` (Godot), `package.json` with a game framework such as Phaser, Three.js, Babylon.js or PixiJS (web).
- Per engine: a game-engineer agent prompt, skills (Unreal C++ macros and reflection, Blueprints, GAS; Unity C#; GDScript), and tools to build, launch, run automation tests and read logs (`Saved/Logs/*.log`, `Editor.log`, Godot output).
- Live editor control goes through MCP servers, such as an Unreal editor MCP plugin, rather than custom code.

Status: `packages/plugins/gamedev/` exists with engine detection, the Game Engineer agent (its instructions are appended in the `context` hook because an agent's own `system` field replaces OpenCode's base prompt), the `web-game` skill, and the web tools `game_project`, `game_build` and `game_playtest` (headless Edge or Chrome through `playwright-core`). Run `bun test` in the plugin folder. A Phaser test game lives in `playground/web-game/`, which git ignores.

Unreal (Windows): `src/unreal.ts` and `src/tools/unreal.ts` add `game_build` (Unreal Build Tool), `game_logs`, `game_playtest` (headless `-game -nullrhi -DisablePython`), `game_test` (automation) and `game_editor`, plus the `unreal-cpp` skill and the editor's MCP server at `http://localhost:8000/mcp`. The test project is `F:\Prj\Drifter` (UE 5.8, no version control; a pre-change snapshot of its Source and Config is in the session scratchpad). Lessons: the `AllToolsets` plugin floods playtests with errors, so enable toolsets individually; the editor ignores `taskkill` without `/F`, so close it with `CloseMainWindow`; UE 5.8's MCP server exposes three meta tools (`list_toolsets`, `describe_toolset`, `call_tool`).

Run OpenCode from source on Windows from `packages/cli` (the repo's `bun run dev <dir>`), not from inside the project folder, or Bun loses the CLI's `bunfig.toml` preload. Use the `claude-agent` provider (`claude-agent/sonnet`) to run on a Claude subscription through the local Claude Code login.

## Upstream edits

Every change this fork makes to an upstream file, so merges stay predictable.

| File | Change | Why |
| ---- | ------ | --- |
| `CLAUDE.md` | Added | Fork instructions (new file) |
| `bun.lock` | New workspace entry for `@leemeoyi/plugin-gamedev` | Bun records every workspace package. On a merge conflict, take upstream's file and run `bun install` |

## Commands

Bun 1.4.4 is installed at `~/.bun/bin`. Run commands from a package folder, not the repo root.

- Type-check a package: `bun run typecheck` inside `packages/<name>`
- Tests: `bun test` inside `packages/<name>`. The root `test` script refuses on purpose.
- Lint: `bun run lint` at the root, or `bunx oxlint <file>` for one file.
- Run the TUI from source: `bun run dev` at the root.
- Get upstream changes: `git fetch upstream`, then `git merge upstream/dev`.

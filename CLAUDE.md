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

To be defined: target engines, tools (asset pipeline, build and run, log reading), and agents.

## Upstream edits

Every change this fork makes to an upstream file, so merges stay predictable.

| File | Change | Why |
| ---- | ------ | --- |
| `CLAUDE.md` | Added | Fork instructions (new file) |

## Commands

Bun 1.4.4 is installed at `~/.bun/bin`. Run commands from a package folder, not the repo root.

- Type-check a package: `bun run typecheck` inside `packages/<name>`
- Tests: `bun test` inside `packages/<name>`. The root `test` script refuses on purpose.
- Lint: `bun run lint` at the root, or `bunx oxlint <file>` for one file.
- Run the TUI from source: `bun run dev` at the root.
- Get upstream changes: `git fetch upstream`, then `git merge upstream/dev`.

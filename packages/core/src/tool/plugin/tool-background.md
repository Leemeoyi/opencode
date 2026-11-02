# Async tools: design note

Fork-only. Goal: the agent can start any tool call in the background, keep working, and later wait for one, any,
all or a quorum of them.

## Where tools actually run

- Core's session runner runs tools itself. `session/runner/step.ts` forks one fiber per `tool-call` event and calls
  `prepared.executeTool`, which is `Tool.Snapshot.execute` (`tool.ts`). That path runs the `execute.before` and
  `execute.after` hooks and the session's permission filtering.
- `packages/ai/src/loop.ts` and `tool-runtime.ts` belong to the standalone `@opencode/ai` loop. Core does not use
  them (AGENTS.md: "Do not add an in-memory tool loop"). **They need no change.**
- `Job.Service` (`job.ts`) can already run any `Effect<string>` as a job, then `wait`, `background` and `cancel` it.
  `cancelSession` cancels every job whose `metadata.sessionID` matches, so session cancel covers new jobs for free.

So the whole feature fits in tools. Nothing in the tool loop or job system changes.

## Tools

### `tool_start` { tool, input, description? } -> { jobID }

- Gets a `Tool.Snapshot` using the session's merged agent and session permissions (the same call
  `session/context.ts` makes), then runs `snapshot.execute({ call: { id: jobID, name: tool, input } })` inside
  `jobs.start({ id: jobID, type: "tool", metadata: { sessionID, tool }, run })`, and returns right away.
- The output is the tool's text content, the same text the model would have got from a direct call.
- Any tool the model can call directly can be started, including `execute` (Code Mode), `shell`, `subagent` and the
  gamedev tools. A tool the session cannot call stays unavailable. Its own permission checks still run, and a
  prompt appears as usual.
- Refused: `tool_start`, `tool_wait`, `subagent_wait` (nesting), and `question` (it needs the user's answer).
- A `background` key in the started tool's input is dropped. Otherwise `shell` or `subagent` would return a
  "moved to the background" placeholder as the job's result, and the real result would arrive in their own notice.
  Models do pass it (seen live on DeepSeek).

### `tool_wait` { ids, mode?, count?, timeout?, cancelRest? }

- Same contract as `subagent_wait`: `all` (default), `any` (first success), `quorum` (`count` successes); `timeout`
  in seconds, default 600, max 3600; `0` checks once and returns. `cancelRest` cancels whatever is still running.
- `ids` can be any job this session owns: `tool_start` job IDs, background shell IDs and background subagent
  session IDs. They are all `Job` IDs, so one wait tool covers all three.
- Each result is clipped to 8000 characters, as in `subagent_wait`.
- `subagent_wait` stays as it is. It can become an alias of `tool_wait` later.

### Completion notices

When a started tool finishes and no `tool_wait` has returned its result, a synthetic notice is posted to the
session, the way background shells do (`<tool jobID=... state=...>output</tool>`). This wakes an idle session.
A notice for a job that a running `tool_wait` watches waits until that wait ends, and is skipped if the wait
returned the job's result. A duplicate is still possible when a job finishes before a wait on it starts. The tool
description says to ignore notices whose results are known.

## Limits (v1)

- **Not durable.** Started tools run in memory, with no `recovery` kind, so they are lost on a service restart. A
  later `tool_wait` reports them as unknown. Persisting them needs a new `recovery` kind in `job.ts` and the job
  table: an upstream edit with replay questions (re-running a non-idempotent tool). Left for later.
- Background jobs without `recovery` are not counted by `SessionBackground.outstanding`, so the session can go idle
  while they run. The completion notice wakes it again, as with shells today.
- Live progress updates (`context.progress`) of a started tool are dropped. The tool part shows only the start.

## Code and upstream edits

- New file `packages/core/src/tool/plugin/tool-background.ts`: both tools in one plugin, since they share the
  notice state.
- `packages/core/src/plugin/internal.ts`: import and register it (2 lines). The plugin needs `Job.Service` and
  `Tool.Service`, which external plugins cannot reach.
- Tests: `packages/core/test/tool-background.test.ts`, covering start and wait all/any/quorum, timeout, cancelRest,
  a denied tool, a refused nested start, and waiting on a background shell.
- Live test (done, DeepSeek in `playground/memory-test`): two shell sleeps (6s, 25s) and a `grep` started in one
  step, then `tool_wait` quorum 2 with `cancelRest` returned after about 6s and cancelled the 25s job. A second run
  started a shell job, ended the turn, and was woken by the `<tool>` notice with the real output.
- Running `opencode run` from a script: close stdin (`< /dev/null`), or the client waits on it before sending the
  prompt.

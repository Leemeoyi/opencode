# Memory

An opt-in OpenCode plugin for long sessions without context rot. Instead of compacting a conversation into a lossy summary, it keeps a small, always-current memory and lets the agent look up anything else from the full history. This plugin is part of the Leemeoyi/opencode fork and is not made by the OpenCode team. See [DESIGN.md](DESIGN.md) for the reasoning.

## What it adds

| Piece | Providers | What it does |
| ----- | --------- | ------------ |
| `memory` tool | All | Notes the agent keeps current: task, decisions, findings, open problems, next steps. Capped at about 1,500 tokens. |
| Changed tracking | All | Records every `edit`, `write` and `patch` in the notes automatically. |
| `recall` tool | All | Searches the whole session history and fetches any full tool output or turn by its ref. |
| Window management | API providers | Above the high mark, shortens old tool outputs and removes the oldest turns down to the low mark, keeping the original task and the most recent turns, with a one-line index of each removed turn. |
| Compaction fallback | API providers | If a provider still rejects a request as too long, the compaction summary comes from the notes and the turn index instead of a model call. |

With the Claude Agent provider (a claude.ai subscription through Claude Code), Claude Code keeps and compacts its own transcript, so only the notes and recall apply; the notes go in the system prompt and the agent is told to re-read them after a compaction.

On API providers the notes are sent as the last message of each request, and trimming only changes the window when the high mark is crossed, so the start of the request stays the same and stays in the provider's prompt cache.

## Install

```sh
opencode plugin add 'git+https://github.com/Leemeoyi/opencode.git#path:packages/plugins/memory'
```

Or locally, with options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "F:/Claude/OpenCode/packages/plugins/memory",
      "options": { "highTokens": 120000, "lowTokens": 80000 },
    },
  ],
}
```

## Options

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `trim` | `true` | `false` keeps the notes and recall only. |
| `highTokens` | `120000` | Trim when a request is estimated above this, or 60% of the model's context window if smaller. |
| `lowTokens` | `80000` | Trim down to this, or 40% of the window if smaller. |
| `keepTurns` | `6` | Most recent turns kept whole, unless removing older turns is not enough. |
| `toolOutputLimit` | `2000` | Characters above which an old tool output is shortened to its first and last 20 lines. |
| `memoryBudget` | `1500` | Token budget for the notes. |
| `debugFile` | none | Append each request's size before and after trimming to this file, as JSON lines. |

## Tested

Unit tests: `bun test`. Live, on DeepSeek (`deepseek-flash`) with the marks lowered to 14k/9k: over seven turns the agent kept its notes current, answered a question about a turn that had been removed (from its notes) and about a detail in a trimmed tool output (through recall), no compaction ran, and total input was 64% smaller.

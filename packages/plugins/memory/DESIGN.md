# Memory plugin: design

Goal: long sessions (hundreds to thousands of turns) without context rot. Nothing the agent needs is lost to a lossy summary; it is either in a small, always-current memory or can be looked up from the full history.

This is a separate plugin from `gamedev` because it applies to any agent. The Game Engineer is its first user.

## Constraint: two kinds of provider

| Provider | Who owns the conversation | What this plugin can do |
| -------- | ------------------------- | ----------------------- |
| API providers (Anthropic API key, OpenRouter, OpenAI, local models, OpenCode's free models) | OpenCode. It sends the whole transcript on every request, and the `context` hook can rewrite it. | Everything below, including replacing compaction. |
| Claude Agent (claude.ai subscription through Claude Code) | Claude Code. OpenCode sends only the newest message; Claude Code keeps and compacts its own transcript, and its system prompt is set once per process. | Memory notes and recall through tools. Claude Code's own compaction still happens, but the memory survives it. |

So the design has three layers. Layers 1 and 2 work everywhere. Layer 3 needs an API provider.

## Layer 1: memory notes (all providers)

A small structured document per session, which the agent keeps current:

- **Task**: the goal, in the user's words, and the current step.
- **Decisions**: choices made and why, including what the user approved or ruled out.
- **Findings**: facts learned about the project, such as "BP_Civvy's C++ parent DFT_CivilianCharacter was deleted".
- **Changed**: files and assets created, edited or deleted. Collected automatically from tool calls; the agent does not write this section.
- **Open**: unresolved problems and questions waiting on the user.
- **Next**: what to do next.

Tool `memory`: `view`, `add` (an item to a section), `update`, `remove`, `set_task`. The whole document has a size budget (about 1,500 tokens); `add` refuses past it, so the agent must keep items short and remove stale ones. Stored with the plugin's storage, keyed by session, so it survives restarts.

Delivery:

- API providers: injected fresh as a system part on every request by the `context` hook.
- Claude Agent: the agent is told to call `memory view` at the start of work, after Claude Code compacts, and whenever it is unsure what it was doing. Recording decisions and findings as it goes is part of the agent's instructions for every provider.

## Layer 2: recall (all providers)

Tool `recall`: searches the session's history (user messages, the agent's replies, tool calls and full tool outputs) and returns short excerpts with references. `recall` with a reference returns the full original text, for example a tool output that was trimmed.

The plugin API cannot read a session's messages directly, but the `context` hook receives the full transcript before every request on every provider (Claude Agent forwards only the newest part afterwards). The plugin indexes it there, before trimming, so recall sees everything up to the latest request. Nothing is deleted from OpenCode's own session store.

## Layer 3: context window management (API providers only)

In the `context` hook, before each request:

1. **Estimate** the request's size (characters / 4, refined by the provider's reported usage when available).
2. **Keep always**: system parts, the memory block, the session's first user message (the original task), and the last 6 turns verbatim. A turn is a user message plus every assistant and tool message after it, so tool calls and their results always stay in pairs.
3. **Shrink old tool outputs**: results older than 3 turns and longer than 2,000 characters keep their first and last 20 lines plus `[trimmed N lines, recall:<id>]`. The tool-call and tool-result pair stays intact.
4. **Evict old turns** with hysteresis: when the estimate passes the high mark, remove the oldest whole turns until it is under the low mark. The high mark is 120,000 tokens or 60% of the model's context window, whichever is smaller; the low mark is 80,000 tokens or 40%. A fixed ceiling matters because models lose focus long before a 1M-token window is full, and every request pays for its whole input. Between evictions, the start of the request stays identical, so provider prompt caching (Anthropic, DeepSeek) keeps working.
5. **Index what was evicted**: replace evicted turns with one message listing them, one line each, for example `#12 user asked to make the ship faster; edited src/main.js; ran game_playtest (recall:t12)`. The agent can see what happened and recall details.
6. Encrypted reasoning in evicted turns is dropped with them; it is never edited.

Compaction: with the window managed, the provider's reported input stays under OpenCode's compaction threshold, so automatic compaction does not start. If a provider still rejects a request as too long, the plugin answers the `compaction` hook with the memory notes plus the eviction index, so no model call is spent on a lossy summary. Users can also set `"compaction": { "auto": false }`.

Settings, through the plugin's options: `high` and `low` marks, `keepTurns`, `toolOutputLimit`, `memoryBudget`, and `trim: false` to keep layers 1 and 2 only.

## Testing

- Unit tests: trimming on synthetic transcripts (tool pairs never split, the first message and the last turns kept, hysteresis keeps the prefix stable, tool outputs shrunk with working recall references); memory budget and sections; recall search.
- Live, API provider: a long scripted session on DeepSeek (`deepseek-flash`, 1M-token window, cheap input) with lowered marks so trimming happens early, checking that requests stay under the high mark, no compaction runs, and the agent recalls an early detail after it was evicted.
- Live, Claude Agent: a session on Drifter where the agent records findings, then answers a question about an early finding from `memory view` and `recall`.

## Not in the first version

- Memory shared across sessions or projects (project-level notes).
- Semantic or vector search in recall; keyword search first.
- Changing OpenCode's core or the Claude Agent provider.

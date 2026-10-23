# dsh-notebook · Loose-leaf Notebook

**English** · [简体中文](README.md)

A memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns the conversation history that compaction pushed out of the model's context into a searchable local notebook, so the model can recall a detail by keyword instead of losing it.

## Why this exists

DSH keeps the full session log. Compaction does not delete it — it only replaces the part the model can still see with a summary. So "compacted" does not have to mean "forgotten": the raw material is still on disk.

Context is paid for on every request; a notebook entry is paid for once, when it is actually read. That is the whole trade.

dsh-notebook indexes that raw material and gives the model three tools to reach it.

## How it works

1. **Continuous capture** — every `user/message` and `assistant/message` becomes one entry. No model calls, no extra tokens.
2. **Three time tiers, derived from the live surface** — `near` = still in context, `mid` = compacted away recently, `far` = compacted away long ago. The tier comes from `session.surface`, not from a date cutoff, so it follows what actually happened to the conversation.
3. **Two browsing axes** — `kind`: `human` (the user), `self` (the assistant), `reflection` (notes the assistant writes for itself). `tag`: 感情 emotion / 重要节点 milestones / 回忆 memories / 偏好 preferences / 技术 technical / 日常 daily, assigned by a small keyword lexicon.
4. **Pull on demand** — search for ids, read the original text, bookmark what matters.

The notebook is **not** part of every request. What stays resident is one short prompt section plus three tool schemas; entry text enters the context only when the model asks for it.

## Tools

| Tool | What it does |
| --- | --- |
| `notebook_search` | Keyword search with optional `kind` / `tag` / `tier` filters, returning numbered summary cards. Omit `query` to list the newest entries. |
| `notebook_read` | Read entries by id, with optional surrounding context (`before` / `after`) or a whole bookmark page (`page`). Bounded by a character budget and says when it truncated. |
| `notebook_mark` | Create a bookmark page from `ids` + `title`, and/or write a `reflection` entry from `text`. Both at once is fine. |

There is also a `/notebook` command for the human: entry counts, tiers, tags, and bookmarks for the current session.

## Install

Not published to npm. Clone the repository, then let DSH install from the local directory.

```bash
git clone https://github.com/yya12123/dsh-notebook.git
```

Then ask your DSH agent to install that directory (pass the absolute path as the target):

> Install the bundle at `C:\path\to\dsh-notebook` with `plugin_manager`'s `install_bundle`.

The tools and the prompt section appear immediately; restart DSH if they do not.

**Re-install after editing.** A bundle installed from a linked local directory does not hot-swap already-loaded modules: run `remove_bundle`, then `install_bundle`, or you keep running the old code. This differs from ordinary plugins.

Verified on DSH 0.2.1-rc.2.

## Configuration

Every key is optional; the defaults below apply when it is omitted. They live under the plugin's row in `cordis.patch.yml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `~/.dsh/notebook` | Where the per-session JSONL files are kept |
| `entryChars` | `4000` | Max characters stored per entry (long pastes are clipped) |
| `abstractChars` | `140` | Characters kept for the one-line abstract in search results |
| `midTurns` | `20` | An archived entry older than this many turns becomes `far` |
| `searchLimit` | `8` | Default number of search hits |
| `readMaxChars` | `2400` | Default character budget for one read |
| `instructions` | `true` | Add the short system-prompt section that tells the model the notebook exists |
| `includeSubagents` | `false` | Also keep notebooks for subagent sessions |
| `tagRules` | `{}` | Extra tag patterns, e.g. `{ family: '妈妈|爸爸|家里' }` |

## Data and privacy

- Everything stays local: `~/.dsh/notebook/<sessionId>.jsonl`, one record per line, readable in any text editor.
- The session log is never modified, and nothing is sent to any service.
- The notebook is a **derived cache**: delete the files and it rebuilds itself from the session log on the next start.

## Known limits

- The plugin does **not** compact. Compaction remains DSH's job — the `standard` preset mounts `compaction-basic` inside an isolated group — and the notebook only guarantees the text survives it. In a profile where nothing compacts, old messages never leave the context, so the notebook costs its resident overhead without saving tokens.
- One notebook per session. Cross-session memory is out of scope for this version.
- Tags come from a keyword lexicon, not a model call. Retrieval quality comes from full-text search (CJK bigrams + BM25); tags are for browsing.
- Model-facing strings (tool descriptions, result headers, tags) are currently Chinese. Models handle that fine, but the plugin is not localized yet.

## License

[MIT](LICENSE)

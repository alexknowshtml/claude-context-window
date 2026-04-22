# claude-context-window

A real-time context window visualizer for active [Claude Code](https://claude.ai/code) sessions.

Watches your Claude Code JSONL transcripts as they update and renders a live web dashboard showing token usage, cost estimates, cache hit rate, and a turn-by-turn breakdown — so you always know how much context you have left.

![Screenshot of the context window visualizer](https://github.com/user-attachments/assets/placeholder)

## Features

- **Live updates** — polls the active transcript every 2 seconds, pushes changes via WebSocket
- **Token breakdown** — color-coded blocks for system prompt, user messages, assistant responses, skill prompts, memory files, and tool results
- **Log-scale visualization** — block heights use a log scale so both small and large blocks are visually distinct
- **Cache metrics** — prompt cache hit rate and estimated session cost (Sonnet 4.6 pricing by default)
- **Compaction warning** — banner appears when you're approaching Claude Code's 200k context limit
- **Sparkline chart** — token growth over turns with a 150k threshold line
- **Thinking detection** — shows a badge when extended thinking is active in the current session
- **Session stats** — duration, turns, last activity time
- **Auto-detect** — finds the most recently active Claude Code project automatically

## Usage

### With Bun (recommended)

```bash
bun run server.ts
```

Opens at `http://localhost:3456`.

### With a specific project

```bash
bun run server.ts --project ~/.claude/projects/my-project-slug
```

Or via environment variable:

```bash
CLAUDE_PROJECT_DIR=~/.claude/projects/my-project-slug bun run server.ts
```

### With Node.js / tsx

```bash
npx tsx server.ts
```

## How it works

Claude Code writes a JSONL transcript to `~/.claude/projects/<project-slug>/*.jsonl` for every session. This server:

1. Watches that directory for the most recently modified `.jsonl` file
2. Parses each line (message objects with `usage` fields)
3. Infers the hidden base system prompt size from the first assistant message's `cache_creation_input_tokens`
4. Renders a live dashboard with token counts, estimated costs, and turn history

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | HTTP server port |
| `CLAUDE_PROJECT_DIR` | auto-detect | Path to a specific Claude project directory |
| `MODEL_LIMIT` | `200000` | Context window size (tokens) |
| `PRICE_INPUT` | `3.00` | Input price per million tokens |
| `PRICE_CACHE_WRITE` | `3.75` | Cache write price per million tokens |
| `PRICE_CACHE_READ` | `0.30` | Cache read price per million tokens |
| `PRICE_OUTPUT` | `15.00` | Output price per million tokens |

Default pricing matches [Claude Sonnet 4.6](https://www.anthropic.com/pricing). Adjust for other models.

## Requirements

- [Bun](https://bun.sh) (or Node.js + tsx)
- Claude Code installed and actively running a session

## License

MIT

#!/usr/bin/env bun
/**
 * Claude Code Context Window Visualizer
 *
 * Real-time dashboard for your active Claude Code session.
 * Parses JSONL transcripts, shows token usage by type, cache hit rate,
 * estimated cost, session duration, and a compaction warning.
 *
 * Usage:
 *   bun run server.ts
 *   bun run server.ts --project ~/.claude/projects/my-project
 *   PORT=4000 bun run server.ts
 *   CLAUDE_PROJECT_DIR=~/.claude/projects/my-project bun run server.ts
 */

import { watch } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";

const PORT = parseInt(process.env.PORT ?? "3456");
const MODEL_LIMIT = parseInt(process.env.MODEL_LIMIT ?? "200000");

// ─── Project Directory Resolution ─────────────────────────────────────────────
// Priority: --project flag > CLAUDE_PROJECT_DIR env > auto-detect

function getProjectDirFromArgs(): string | null {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1].replace(/^~/, homedir());
  }
  return null;
}

async function autoDetectProjectDir(): Promise<string> {
  const baseDir = join(homedir(), ".claude", "projects");
  try {
    const entries = await readdir(baseDir);
    const withStats = await Promise.all(
      entries.map(async (e) => {
        try {
          const s = await stat(join(baseDir, e));
          return { name: e, mtime: s.mtime.getTime(), isDir: s.isDirectory() };
        } catch {
          return null;
        }
      })
    );
    const dirs = withStats
      .filter((e): e is NonNullable<typeof e> => e !== null && e.isDir)
      .sort((a, b) => b.mtime - a.mtime);

    if (dirs.length === 0) throw new Error("No project directories found");
    return join(baseDir, dirs[0].name);
  } catch {
    throw new Error(
      `Could not find Claude Code projects at ${baseDir}. ` +
        `Pass --project /path/to/project or set CLAUDE_PROJECT_DIR.`
    );
  }
}

async function resolveProjectDir(): Promise<string> {
  const fromArg = getProjectDirFromArgs();
  if (fromArg) return resolve(fromArg);

  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return resolve(fromEnv.replace(/^~/, homedir()));

  return autoDetectProjectDir();
}

// ─── Types ────────────────────────────────────────────────────────────────────

type BlockType =
  | "system"
  | "skill_prompt"
  | "memory"
  | "user"
  | "assistant"
  | "tool_result";

interface ContextBlock {
  type: BlockType;
  label: string;
  tokens: number;
}

interface TurnStat {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  hasThinking: boolean;
  timestamp?: string;
}

interface SessionStats {
  sessionId: string;
  model: string;
  tokensUsed: number;
  tokensRemaining: number;
  capacityPct: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cacheHitPct: number;
  estimatedCostUsd: number;
  contentBlocks: number;
  skillsLoaded: string[];
  blocks: ContextBlock[];
  byType: Record<BlockType, number>;
  turns: TurnStat[];
  hasThinking: boolean;
  sessionStartedAt?: string;
  sessionLastActivityAt?: string;
  compactionWarning: boolean;
  updatedAt: string;
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

function estTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}

// ─── Content Classification ───────────────────────────────────────────────────

function classifyContent(text: string, toolName?: string): BlockType {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    if (
      text.includes("/.claude/skills/") ||
      text.includes("SKILL.md") ||
      text.match(/skills\/[a-z-]+\//)
    )
      return "skill_prompt";
    if (
      text.includes("/memory/") ||
      text.includes("MEMORY.md") ||
      text.match(/memory\/[a-z_-]+\.md/)
    )
      return "memory";
  }
  return "tool_result";
}

// ─── Session Discovery ────────────────────────────────────────────────────────

let PROJECTS_DIR = "";

async function findActiveSessions(): Promise<Array<{ id: string; mtime: number }>> {
  try {
    const files = await readdir(PROJECTS_DIR);
    const jsonls = files.filter((f) => f.endsWith(".jsonl"));
    const stats = await Promise.all(
      jsonls.map(async (f) => {
        const s = await stat(join(PROJECTS_DIR, f));
        return { id: f.replace(".jsonl", ""), mtime: s.mtime.getTime() };
      })
    );
    return stats.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  } catch {
    return [];
  }
}

// ─── Session Parser ───────────────────────────────────────────────────────────

async function parseSession(sessionId: string): Promise<SessionStats> {
  const filePath = join(PROJECTS_DIR, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return emptyStats(sessionId);
  }

  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const blocks: ContextBlock[] = [];
  const skills: string[] = [];
  const turns: TurnStat[] = [];
  let latestUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let model = "claude-sonnet-4-6";
  let sessionStartedAt: string | undefined;
  let sessionLastActivityAt: string | undefined;
  let sessionHasThinking = false;

  const toolUseNames = new Map<string, string>();
  let firstAssistantCacheCreate = 0;
  let seenFirstAssistant = false;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string;
    const timestamp = obj.timestamp as string | undefined;
    if (timestamp) {
      if (!sessionStartedAt) sessionStartedAt = timestamp;
      sessionLastActivityAt = timestamp;
    }

    if (type === "user") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const content = msg.content;

      if (typeof content === "string") {
        // Extract system-reminder injections
        const sysBlocks =
          content.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) ?? [];
        for (const sb of sysBlocks) {
          blocks.push({ type: "system", label: "System Context", tokens: estTokens(sb) });
        }
        // Extract real user message (works for both plain and injected formats)
        const injectedMsg = content.match(/\*\*Message:\*\* (.+)/)?.[1];
        const userText = injectedMsg ?? (!content.includes("[CLAUDE-INTERNAL") ? content : null);
        if (userText) {
          blocks.push({
            type: "user",
            label: `User: "${userText.slice(0, 60)}"`,
            tokens: estTokens(userText),
          });
        }
      }

      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if ((block.type as string) === "tool_result") {
            const toolUseId = block.tool_use_id as string | undefined;
            const toolName = toolUseId ? toolUseNames.get(toolUseId) : undefined;
            const resultContent = block.content;
            const resultText =
              typeof resultContent === "string"
                ? resultContent
                : Array.isArray(resultContent)
                ? (resultContent as Record<string, unknown>[])
                    .map((c) => (c.text as string) || "")
                    .join("")
                : "";

            const bType = classifyContent(resultText, toolName);
            let label = toolName ? `${toolName} result` : "Tool Result";

            if (bType === "skill_prompt") {
              const m = resultText.match(/skills\/([a-z-]+)\//);
              const skillName = m?.[1] ?? "skill";
              label = `${skillName} SKILL.md`;
              if (!skills.includes(skillName)) skills.push(skillName);
            } else if (bType === "memory") {
              const m = resultText.match(/memory\/([^.]+)\.md/);
              label = m ? `memory/${m[1]}` : "Memory file";
            }

            blocks.push({ type: bType, label, tokens: estTokens(resultText) });
          }
        }
      }
    }

    if (type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      if (msg.model) model = msg.model as string;

      const usage = msg.usage as Record<string, number> | undefined;
      if (usage) {
        latestUsage = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreate: usage.cache_creation_input_tokens ?? 0,
        };
        if (!seenFirstAssistant) {
          firstAssistantCacheCreate = usage.cache_creation_input_tokens ?? 0;
          seenFirstAssistant = true;
        }
      }

      let turnHasThinking = false;
      const msgContent = msg.content as Record<string, unknown>[] | undefined;

      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          const bt = block.type as string;
          if (bt === "thinking") {
            turnHasThinking = true;
            sessionHasThinking = true;
          }
          if (bt === "text" && block.text) {
            blocks.push({
              type: "assistant",
              label: `Assistant: "${(block.text as string).slice(0, 60).replace(/\n/g, " ")}"`,
              tokens: estTokens(block.text as string),
            });
          }
          if (bt === "tool_use") {
            const toolId = block.id as string;
            const toolName = block.name as string;
            if (toolId && toolName) toolUseNames.set(toolId, toolName);
            const inputStr = JSON.stringify(block.input ?? {});
            blocks.push({
              type: "tool_result",
              label: `${toolName}(${Object.keys((block.input as Record<string, unknown>) ?? {}).slice(0, 2).join(", ")})`,
              tokens: estTokens(inputStr),
            });
          }
        }
      }

      if (usage) {
        turns.push({
          turn: turns.length + 1,
          inputTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreate: usage.cache_creation_input_tokens ?? 0,
          hasThinking: turnHasThinking,
          timestamp,
        });
      }
    }
  }

  // Infer system prompt size from first-turn cache creation tokens
  if (firstAssistantCacheCreate > 0) {
    const parsedEarly = blocks
      .filter((b) => b.type === "user" || b.type === "system")
      .reduce((s, b) => s + b.tokens, 0);
    const inferredSystem = Math.max(0, firstAssistantCacheCreate - parsedEarly);
    if (inferredSystem > 500) {
      blocks.unshift({
        type: "system",
        label: "Base system prompt (CLAUDE.md + tool schemas + context)",
        tokens: inferredSystem,
      });
    }
  }

  const byType: Record<BlockType, number> = {
    system: 0, skill_prompt: 0, memory: 0, user: 0, assistant: 0, tool_result: 0,
  };
  for (const b of blocks) byType[b.type] += b.tokens;

  const totalEstimated = Object.values(byType).reduce((a, b) => a + b, 0);
  const tokensUsed =
    latestUsage.input + latestUsage.cacheRead + latestUsage.cacheCreate > 0
      ? latestUsage.input + latestUsage.cacheRead + latestUsage.cacheCreate
      : totalEstimated;

  const tokensRemaining = Math.max(0, MODEL_LIMIT - tokensUsed);
  const capacityPct = Math.min(100, (tokensUsed / MODEL_LIMIT) * 100);

  const totalCacheTokens = latestUsage.cacheRead + latestUsage.cacheCreate;
  const cacheHitPct = totalCacheTokens > 0
    ? Math.round((latestUsage.cacheRead / totalCacheTokens) * 100)
    : 0;

  // Pricing: claude-sonnet-4-6 (override with PRICE_* env vars for other models)
  const PRICE = {
    input: parseFloat(process.env.PRICE_INPUT ?? "3.0"),
    cacheWrite: parseFloat(process.env.PRICE_CACHE_WRITE ?? "3.75"),
    cacheRead: parseFloat(process.env.PRICE_CACHE_READ ?? "0.30"),
    output: parseFloat(process.env.PRICE_OUTPUT ?? "15.0"),
  };
  const estimatedCostUsd =
    (latestUsage.input / 1e6) * PRICE.input +
    (latestUsage.cacheCreate / 1e6) * PRICE.cacheWrite +
    (latestUsage.cacheRead / 1e6) * PRICE.cacheRead +
    (latestUsage.output / 1e6) * PRICE.output;

  return {
    sessionId,
    model,
    tokensUsed,
    tokensRemaining,
    capacityPct,
    outputTokens: latestUsage.output,
    cacheReadTokens: latestUsage.cacheRead,
    cacheCreateTokens: latestUsage.cacheCreate,
    cacheHitPct,
    estimatedCostUsd,
    contentBlocks: blocks.length,
    skillsLoaded: skills,
    blocks,
    byType,
    turns,
    hasThinking: sessionHasThinking,
    sessionStartedAt,
    sessionLastActivityAt,
    compactionWarning: tokensUsed >= 150_000,
    updatedAt: new Date().toISOString(),
  };
}

function emptyStats(sessionId: string): SessionStats {
  return {
    sessionId,
    model: "unknown",
    tokensUsed: 0,
    tokensRemaining: MODEL_LIMIT,
    capacityPct: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitPct: 0,
    estimatedCostUsd: 0,
    contentBlocks: 0,
    skillsLoaded: [],
    blocks: [],
    byType: { system: 0, skill_prompt: 0, memory: 0, user: 0, assistant: 0, tool_result: 0 },
    turns: [],
    hasThinking: false,
    compactionWarning: false,
    updatedAt: new Date().toISOString(),
  };
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Window</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  :root {
    --bg:      #fdf8f2; --bg2: #f5ede0; --bg3: #ede1d0;
    --border:  #ddd0be; --text: #3b2a1a; --muted: #9a8470; --accent: #c2622a;
    --c-system: #9b59b6; --c-skill: #e07b25; --c-memory: #3a9e72;
    --c-user: #2e7abf; --c-assistant: #b8860b; --c-tool: #c0392b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: Inter, system-ui, sans-serif; font-size: 13px; line-height: 1.5; }

  header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; background: #fff9f3; }
  .live-badge { color: #3a9e72; font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 5px; margin-bottom: 2px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #3a9e72; animation: pulse 1.8s infinite; flex-shrink: 0; }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
  h1 { font-size: 20px; color: var(--accent); font-weight: 600; letter-spacing: -0.3px; }
  .model-info { text-align: right; color: var(--muted); font-size: 12px; line-height: 1.7; }
  .model-info span { color: var(--text); font-weight: 500; }

  .stats-bar { display: grid; grid-template-columns: repeat(5, 1fr); border-bottom: 1px solid var(--border); background: #fff9f3; }
  .stat { padding: 14px 16px; border-right: 1px solid var(--border); }
  .stat:last-child { border-right: none; }
  .stat-value { font-size: 24px; color: var(--accent); font-weight: 700; line-height: 1; letter-spacing: -0.5px; }
  .stat-label { font-size: 10px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 5px; }

  #compaction-banner { display: none; background: #fef3c7; border-bottom: 2px solid #d97706; padding: 8px 20px; font-size: 12px; font-weight: 600; color: #92400e; align-items: center; gap: 8px; }
  #compaction-banner code { background: rgba(0,0,0,0.08); padding: 1px 5px; border-radius: 3px; }

  .capacity-bar { height: 22px; background: var(--bg3); position: relative; border-bottom: 1px solid var(--border); overflow: hidden; }
  .capacity-fill { height: 100%; background: linear-gradient(90deg, #3a9e72 0%, #e07b25 70%, #c0392b 100%); transition: width 0.6s ease; opacity: 0.75; }
  .capacity-label { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--muted); font-weight: 500; }

  .meta-bar { display: flex; border-bottom: 1px solid var(--border); background: #fdf5ec; flex-wrap: wrap; }
  .meta-item { padding: 7px 16px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 1px; }
  .meta-item:last-child { border-right: none; }
  .meta-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .meta-value { font-size: 13px; color: var(--text); font-weight: 600; }

  .legend { display: flex; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; background: #fdf5ec; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); font-weight: 500; }
  .legend-dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; opacity: 0.85; }

  .session-selector { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; background: #fff9f3; }
  .session-selector label { font-size: 11px; color: var(--muted); font-weight: 600; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.5px; }
  .session-selector select { background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 12px; padding: 4px 8px; border-radius: 6px; font-family: inherit; flex: 1; min-width: 0; outline: none; }
  .session-selector select:focus { border-color: var(--accent); }

  .main { display: grid; grid-template-columns: 210px 1fr 250px; height: calc(100vh - 200px); min-height: 400px; }

  .context-map { border-right: 1px solid var(--border); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 3px; background: var(--bg); }
  .context-map-label { font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
  .block-row { display: flex; align-items: stretch; gap: 6px; }
  .block-bar { width: 7px; border-radius: 3px; flex-shrink: 0; opacity: 0.8; }
  .block-info { flex: 1; overflow: hidden; }
  .block-label { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .block-tokens { font-size: 10px; color: var(--text); font-weight: 500; }

  .timeline { overflow-y: auto; padding: 12px; border-right: 1px solid var(--border); background: var(--bg2); }
  .timeline-label { font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; }
  .timeline-note { font-size: 10px; color: var(--muted); margin-bottom: 10px; line-height: 1.5; }
  .stacked-container { display: flex; flex-direction: column; gap: 2px; }
  .stacked-block { padding: 4px 10px; border-radius: 5px; cursor: default; opacity: 0.88; transition: opacity 0.12s, transform 0.1s; }
  .stacked-block:hover { opacity: 1; transform: translateX(2px); }
  .stacked-block-label { font-size: 10px; color: rgba(255,255,255,0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .stacked-block-tok { font-size: 9px; color: rgba(255,255,255,0.65); }

  .sidebar { overflow-y: auto; padding: 14px; background: var(--bg); }
  .sidebar-section { margin-bottom: 20px; }
  .sidebar-title { font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
  .type-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .type-bar-bg { flex: 1; height: 10px; background: var(--bg3); border-radius: 10px; overflow: hidden; }
  .type-bar-fill { height: 100%; border-radius: 10px; transition: width 0.5s ease; }
  .type-name { width: 76px; font-size: 11px; color: var(--muted); flex-shrink: 0; font-weight: 500; }
  .type-count { width: 40px; font-size: 11px; color: var(--text); text-align: right; flex-shrink: 0; font-weight: 600; }

  .notable-item { background: #fff9f3; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(60,30,10,0.05); }
  .notable-tag { font-size: 9px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
  .notable-value { font-size: 12px; color: var(--text); font-weight: 500; margin-bottom: 2px; }
  .notable-sub { font-size: 10px; color: var(--muted); line-height: 1.4; }

  .loading { display: flex; align-items: center; justify-content: center; height: 200px; color: var(--muted); font-size: 13px; }

  @media (max-width: 700px) {
    .stats-bar { grid-template-columns: repeat(3, 1fr); }
    .stat { padding: 10px; }
    .stat-value { font-size: 20px; }
    .stat-label { font-size: 8px; }
    .main { display: flex; flex-direction: column; height: auto; }
    .context-map { border-right: none; border-bottom: 1px solid var(--border); max-height: 200px; order: 2; }
    .timeline { border-right: none; border-bottom: 1px solid var(--border); max-height: 55vh; order: 1; }
    .sidebar { order: 3; }
  }
  @media (max-width: 420px) {
    .stats-bar { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>

<header>
  <div>
    <div class="live-badge"><span class="live-dot"></span>LIVE SESSION</div>
    <h1>Context Window</h1>
  </div>
  <div class="model-info">
    Model: <span id="model-name">—</span><br>
    Limit: <span id="model-limit">—</span> tokens<br>
    Turns: <span id="turn-count">0</span>
  </div>
</header>

<div class="stats-bar">
  <div class="stat"><div class="stat-value" id="stat-used">—</div><div class="stat-label">Tokens Used</div></div>
  <div class="stat"><div class="stat-value" id="stat-remaining" style="color:var(--c-user)">—</div><div class="stat-label">Remaining</div></div>
  <div class="stat"><div class="stat-value" id="stat-pct">—%</div><div class="stat-label">Capacity Used</div></div>
  <div class="stat"><div class="stat-value" id="stat-blocks">—</div><div class="stat-label">Content Blocks</div></div>
  <div class="stat"><div class="stat-value" id="stat-skills">—</div><div class="stat-label">Skills Loaded</div></div>
</div>

<div id="compaction-banner">⚠️ Approaching context limit — consider running <code>/compact</code> or saving state</div>

<div class="capacity-bar">
  <div class="capacity-fill" id="capacity-fill" style="width:0%"></div>
  <div class="capacity-label" id="capacity-label">0%</div>
</div>

<div class="meta-bar">
  <div class="meta-item"><span class="meta-label">Cache hit</span><span class="meta-value" id="meta-cache">—</span></div>
  <div class="meta-item"><span class="meta-label">Est. cost</span><span class="meta-value" id="meta-cost">—</span></div>
  <div class="meta-item"><span class="meta-label">Duration</span><span class="meta-value" id="meta-duration">—</span></div>
  <div class="meta-item"><span class="meta-label">Last activity</span><span class="meta-value" id="meta-last">—</span></div>
  <div class="meta-item" id="thinking-badge" style="display:none"><span class="meta-label">Extended thinking</span><span class="meta-value" style="color:var(--c-system)">active</span></div>
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-system)"></div>System</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-skill)"></div>Skill Prompt</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-memory)"></div>Memory</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-user)"></div>User</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-assistant)"></div>Assistant</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--c-tool)"></div>Tool/Result</div>
</div>

<div class="session-selector">
  <label>Session:</label>
  <select id="session-select" onchange="selectSession(this.value)"><option>Loading…</option></select>
</div>

<div class="main">
  <div class="context-map" id="context-map">
    <div class="context-map-label">Context Map</div>
    <div class="loading">Connecting…</div>
  </div>
  <div class="timeline">
    <div class="timeline-label">Chronological Context Map</div>
    <div class="timeline-note">Block height ∝ token count (log scale) · newest at top</div>
    <canvas id="sparkline" height="60" style="width:100%;margin-bottom:8px;border-radius:4px;background:var(--bg3);display:block"></canvas>
    <div class="stacked-container" id="stacked-blocks"></div>
  </div>
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-title">Token Breakdown by Type</div>
      <div id="type-breakdown"></div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-title">Notable Context Items</div>
      <div id="notable-items"></div>
    </div>
  </div>
</div>

<script>
const TYPE_COLORS = { system:'var(--c-system)', skill_prompt:'var(--c-skill)', memory:'var(--c-memory)', user:'var(--c-user)', assistant:'var(--c-assistant)', tool_result:'var(--c-tool)' };
const TYPE_LABELS = { system:'System', skill_prompt:'Skill Prompt', memory:'Memory', user:'User', assistant:'Assistant', tool_result:'Tool/Result' };

let ws=null, currentSessionId=null, reconnectTimer=null;

function fmt(n) { return n>=1000?(n/1000).toFixed(1)+'k':String(n); }

function connect(sid) {
  if(ws){ws.close();ws=null;}
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(\`\${proto}//\${location.host}/ws\${sid?'?session='+sid:''}\`);
  ws.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='sessions') populateSessions(d.sessions,d.active);
    else if(d.type==='stats') renderStats(d.stats);
  };
  ws.onclose=()=>{reconnectTimer=setTimeout(()=>connect(currentSessionId),3000);};
}

function populateSessions(sessions,active) {
  const sel=document.getElementById('session-select');
  sel.innerHTML=sessions.map(s=>\`<option value="\${s.id}" \${s.id===active?'selected':''}>\${s.id.slice(0,8)}… (\${new Date(s.mtime).toLocaleTimeString()})</option>\`).join('');
  if(!currentSessionId&&active) currentSessionId=active;
}

function selectSession(id){currentSessionId=id;connect(id);}

function fmtDur(ms){if(ms<60000)return Math.round(ms/1000)+'s';if(ms<3600000)return Math.round(ms/60000)+'m';return(ms/3600000).toFixed(1)+'h';}
function fmtAgo(s){if(!s)return'—';const ms=Date.now()-new Date(s).getTime();return ms<5000?'just now':fmtDur(ms)+' ago';}

function renderStats(s) {
  document.getElementById('model-name').textContent=s.model;
  document.getElementById('model-limit').textContent=(s.tokensUsed+s.tokensRemaining).toLocaleString();
  document.getElementById('turn-count').textContent=s.turns?s.turns.length:0;
  document.getElementById('stat-used').textContent=s.tokensUsed.toLocaleString();
  document.getElementById('stat-remaining').textContent=s.tokensRemaining.toLocaleString();
  document.getElementById('stat-pct').textContent=s.capacityPct.toFixed(1)+'%';
  document.getElementById('stat-blocks').textContent=s.contentBlocks;
  document.getElementById('stat-skills').textContent=s.skillsLoaded.length;
  document.getElementById('capacity-fill').style.width=s.capacityPct+'%';
  document.getElementById('capacity-label').textContent=s.capacityPct.toFixed(1)+'%';
  document.getElementById('compaction-banner').style.display=s.compactionWarning?'flex':'none';
  document.getElementById('meta-cache').textContent=s.cacheHitPct+'%';
  document.getElementById('meta-cost').textContent='$'+s.estimatedCostUsd.toFixed(4);
  if(s.sessionStartedAt&&s.sessionLastActivityAt) {
    document.getElementById('meta-duration').textContent=fmtDur(new Date(s.sessionLastActivityAt)-new Date(s.sessionStartedAt));
  }
  document.getElementById('meta-last').textContent=fmtAgo(s.sessionLastActivityAt);
  document.getElementById('thinking-badge').style.display=s.hasThinking?'flex':'none';
  renderContextMap(s.blocks);
  renderStackedBlocks(s.blocks);
  renderSparkline(s.turns||[]);
  renderTypeBreakdown(s.byType);
  renderNotable(s);
}

function renderSparkline(turns) {
  const c=document.getElementById('sparkline');
  if(!c||!turns.length)return;
  const ctx=c.getContext('2d'),W=c.offsetWidth||300,H=60;
  c.width=W; ctx.clearRect(0,0,W,H);
  const vals=turns.map(t=>t.inputTokens),max=Math.max(...vals,1),step=W/Math.max(vals.length-1,1);
  ctx.beginPath(); ctx.moveTo(0,H);
  vals.forEach((v,i)=>ctx.lineTo(i*step,H-(v/max)*(H-6)-2));
  ctx.lineTo((vals.length-1)*step,H); ctx.closePath();
  ctx.fillStyle='rgba(194,98,42,0.18)'; ctx.fill();
  ctx.beginPath();
  vals.forEach((v,i)=>{ const x=i*step,y=H-(v/max)*(H-6)-2; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.strokeStyle='#c2622a'; ctx.lineWidth=2; ctx.stroke();
  const ty=H-(150000/max)*(H-6)-2;
  if(ty>0&&ty<H){ctx.beginPath();ctx.setLineDash([3,3]);ctx.moveTo(0,ty);ctx.lineTo(W,ty);ctx.strokeStyle='#d97706';ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);}
}

function renderContextMap(blocks) {
  const el=document.getElementById('context-map');
  el.innerHTML='<div class="context-map-label">Context Map</div>';
  const maxT=Math.max(...blocks.map(b=>b.tokens),1);
  blocks.forEach(b=>{
    const row=document.createElement('div'); row.className='block-row'; row.title=b.label;
    row.innerHTML=\`<div class="block-bar" style="background:\${TYPE_COLORS[b.type]};min-height:3px;height:\${Math.max(3,Math.round(b.tokens/maxT*60))}px"></div><div class="block-info"><div class="block-label">\${esc(b.label)}</div><div class="block-tokens">\${fmt(b.tokens)} tok</div></div>\`;
    el.appendChild(row);
  });
}

function renderStackedBlocks(blocks) {
  const c=document.getElementById('stacked-blocks'); c.innerHTML='';
  if(!blocks.length)return;
  const maxT=Math.max(...blocks.map(b=>b.tokens),1),logMax=Math.log(maxT+1);
  const MIN=14,MAX=160;
  function bh(t){return Math.round(MIN+(Math.log(t+1)/logMax)*(MAX-MIN));}
  [...blocks].reverse().forEach(b=>{
    const h=bh(b.tokens),d=document.createElement('div');
    d.className='stacked-block'; d.style.background=TYPE_COLORS[b.type]; d.style.height=h+'px';
    d.title=\`\${b.label} — \${b.tokens.toLocaleString()} tokens\`;
    d.innerHTML=h>=30?\`<div class="stacked-block-label">\${esc(TYPE_LABELS[b.type])} · \${esc(b.label.slice(0,40))}</div><div class="stacked-block-tok">\${b.tokens.toLocaleString()} tok</div>\`:h>=18?\`<div class="stacked-block-tok" style="font-size:8px;line-height:1">\${fmt(b.tokens)}</div>\`:'';
    c.appendChild(d);
  });
}

function renderTypeBreakdown(byType) {
  const maxV=Math.max(...Object.values(byType),1);
  document.getElementById('type-breakdown').innerHTML=Object.entries(byType).map(([t,v])=>\`<div class="type-row"><div class="type-name" style="color:\${TYPE_COLORS[t]}">\${TYPE_LABELS[t]}</div><div class="type-bar-bg"><div class="type-bar-fill" style="width:\${(v/maxV*100).toFixed(1)}%;background:\${TYPE_COLORS[t]}"></div></div><div class="type-count">\${fmt(v)}</div></div>\`).join('');
}

function renderNotable(s) {
  const blocks=s.blocks;
  const largest=blocks.reduce((a,b)=>a.tokens>b.tokens?a:b,{label:'—',tokens:0});
  const longestTool=blocks.filter(b=>b.type==='tool_result').reduce((a,b)=>a.tokens>b.tokens?a:b,{label:'—',tokens:0});
  document.getElementById('notable-items').innerHTML=\`
    <div class="notable-item"><div class="notable-tag" style="color:var(--c-skill)">Largest Block</div><div class="notable-value">\${esc(largest.label.slice(0,40))}</div><div class="notable-sub">\${largest.tokens.toLocaleString()} tok</div></div>
    <div class="notable-item"><div class="notable-tag" style="color:var(--c-tool)">Longest Tool Result</div><div class="notable-value">\${esc(longestTool.label.slice(0,40))}</div><div class="notable-sub">\${longestTool.tokens.toLocaleString()} tok</div></div>
    <div class="notable-item"><div class="notable-tag" style="color:var(--c-system)">System Layer</div><div class="notable-value">~\${s.byType.system.toLocaleString()} tok</div><div class="notable-sub">Inferred from first-call cache creation</div></div>
    \${s.skillsLoaded.length?'<div class="notable-item"><div class="notable-tag" style="color:var(--c-skill)">Skills Loaded</div><div class="notable-value">'+s.skillsLoaded.slice(0,5).join(', ')+'</div><div class="notable-sub">'+s.byType.skill_prompt.toLocaleString()+' tok total</div></div>':''}\`;
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

connect(null);
</script>
</body>
</html>`;

// ─── WebSocket State ──────────────────────────────────────────────────────────

const clients = new Set<{ ws: WebSocket; sessionId: string | null }>();

async function broadcastToClient(
  client: { ws: WebSocket; sessionId: string | null },
  sessions: Array<{ id: string; mtime: number }>
) {
  if ((client.ws as unknown as { readyState: number }).readyState !== 1) return;
  client.ws.send(JSON.stringify({ type: "sessions", sessions, active: client.sessionId ?? sessions[0]?.id ?? null }));
  const sid = client.sessionId ?? sessions[0]?.id;
  if (!sid) return;
  const stats = await parseSession(sid);
  client.ws.send(JSON.stringify({ type: "stats", stats }));
}

// ─── File Watcher ─────────────────────────────────────────────────────────────

let watchDebounce: ReturnType<typeof setTimeout> | null = null;

function setupWatcher() {
  try {
    watch(PROJECTS_DIR, { persistent: false }, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(async () => {
        const sessions = await findActiveSessions();
        for (const client of clients) await broadcastToClient(client, sessions);
      }, 500);
    });
  } catch {
    setInterval(async () => {
      if (!clients.size) return;
      const sessions = await findActiveSessions();
      for (const client of clients) await broadcastToClient(client, sessions);
    }, 5000);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

async function main() {
  PROJECTS_DIR = await resolveProjectDir();
  console.log(`Watching: ${PROJECTS_DIR}`);

  const server = Bun.serve({
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") {
        const sid = url.searchParams.get("session") || null;
        const client = { ws: null as unknown as WebSocket, sessionId: sid };
        const ok = server.upgrade(req, { data: client });
        if (!ok) return new Response("WS upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }
      if (url.pathname === "/api/sessions") {
        return new Response(JSON.stringify(await findActiveSessions()), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.startsWith("/api/stats/")) {
        return new Response(JSON.stringify(await parseSession(url.pathname.slice(11))), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(HTML, { headers: { "Content-Type": "text/html" } });
    },
    websocket: {
      async open(ws) {
        const client = ws.data as { ws: WebSocket; sessionId: string | null };
        client.ws = ws as unknown as WebSocket;
        clients.add(client);
        await broadcastToClient(client, await findActiveSessions());
      },
      message() {},
      close(ws) {
        clients.delete(ws.data as { ws: WebSocket; sessionId: string | null });
      },
    },
  });

  setupWatcher();
  console.log(`Context Window running at http://localhost:${PORT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

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
<script src="https://cdn.tailwindcss.com"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', system-ui, sans-serif; }
  .live-dot { animation: pulse-dot 1.8s infinite; }
  @keyframes pulse-dot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.8)} }

  /* Dark mode overrides */
  html.dark body { background-color: #18181b !important; color: #f4f4f5 !important; }
  html.dark header,
  html.dark .cw-panel { background-color: #27272a !important; border-color: #3f3f46 !important; }
  html.dark .cw-border-b { border-color: #3f3f46 !important; }
  html.dark .cw-border-r { border-color: #52525b !important; }
  html.dark .cw-muted { color: #a1a1aa !important; }
  html.dark .cw-submuted { color: #71717a !important; }
  html.dark .cw-progress-bg { background-color: #3f3f46 !important; }
  html.dark .cw-progress-fill { background-color: #e4e4e7 !important; }
  html.dark .cw-stat-pct { color: #e4e4e7 !important; }
  html.dark #session-select { background-color: #27272a !important; color: #e4e4e7 !important; border-color: #3f3f46 !important; }
  html.dark #model-name { background-color: #3f3f46 !important; color: #a1a1aa !important; }
  html.dark #thinking-badge { border-color: #3f3f46 !important; color: #a1a1aa !important; }
  html.dark #dark-toggle { color: #a1a1aa !important; }
  html.dark #dark-toggle:hover { color: #e4e4e7 !important; }
</style>
<script>
  if (localStorage.getItem('cw-dark') === '1') {
    document.documentElement.classList.add('dark');
  }
<\/script>
</head>
<body class="bg-zinc-50 text-zinc-900 min-h-screen">

<!-- Header -->
<header class="bg-white cw-panel cw-border-b border-b border-zinc-200 h-12 px-4 flex items-center gap-3">
  <div class="flex items-center gap-2">
    <span class="live-dot w-1.5 h-1.5 rounded-full bg-emerald-500 block shrink-0" id="map-loading"></span>
    <span class="font-semibold text-sm tracking-tight">Context Window</span>
  </div>
  <span class="text-xs text-zinc-400 bg-zinc-100 rounded-md px-2 py-0.5 font-mono" id="model-name">—</span>
  <span class="hidden text-xs text-zinc-400" id="turn-count"></span>
  <span class="hidden" id="model-limit"></span>
  <div class="ml-auto flex items-center gap-2">
    <button id="dark-toggle" onclick="toggleDark()" title="Toggle dark mode" class="text-zinc-400 hover:text-zinc-700 w-7 h-7 flex items-center justify-center rounded-md hover:bg-zinc-100 transition-colors text-base leading-none">
      <span id="dark-icon">☀️</span>
    </button>
    <select id="session-select" onchange="selectSession(this.value)" class="text-xs text-zinc-600 bg-white border border-zinc-200 rounded-md px-2.5 py-1.5 outline-none font-sans">
      <option value="">Loading…</option>
    </select>
  </div>
</header>

<!-- Token hero -->
<div class="bg-white cw-panel cw-border-b border-b border-zinc-200 px-4 py-4">
  <div class="flex items-end justify-between mb-2.5">
    <div>
      <div class="flex items-baseline gap-1.5">
        <span class="text-3xl font-bold tracking-tight tabular-nums" id="stat-used">—</span>
        <span class="text-zinc-300 text-lg">/</span>
        <span class="text-lg text-zinc-400 cw-muted font-medium tabular-nums" id="stat-limit">200,000</span>
        <span class="text-[10px] font-semibold text-zinc-400 cw-muted uppercase tracking-widest ml-0.5">tok</span>
      </div>
      <p class="text-[11px] text-zinc-400 cw-muted mt-0.5"><span id="stat-remaining">—</span> remaining</p>
    </div>
    <span class="text-2xl font-bold text-zinc-800 cw-stat-pct tabular-nums" id="stat-pct">—%</span>
  </div>
  <div class="h-1.5 bg-zinc-100 cw-progress-bg rounded-full overflow-hidden">
    <div class="h-full rounded-full bg-zinc-800 cw-progress-fill transition-all duration-500" id="capacity-fill" style="width:0%"></div>
  </div>
  <span class="hidden" id="capacity-label"></span>
</div>

<!-- Compaction banner -->
<div id="compaction-banner" style="display:none" class="bg-orange-50 border-b border-orange-200 px-4 py-2 text-xs font-semibold text-orange-700 flex items-center gap-2">
  ⚠️ Approaching context limit — consider running <code class="bg-orange-100 rounded px-1.5 py-0.5 font-mono">/compact</code> to save state
</div>

<!-- Stats strip -->
<div class="bg-white cw-panel cw-border-b border-b border-zinc-200 px-4 flex overflow-x-auto">
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0">
    <div class="text-sm font-semibold tabular-nums" id="meta-cost">$—</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Cost</div>
  </div>
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0">
    <div class="text-sm font-semibold text-emerald-600 tabular-nums" id="meta-cache">—%</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Cache hit</div>
  </div>
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0">
    <div class="text-sm font-semibold tabular-nums" id="meta-duration">—</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Duration</div>
  </div>
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0">
    <div class="text-sm font-semibold tabular-nums" id="stat-blocks">—</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Blocks</div>
  </div>
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0">
    <div class="text-sm font-semibold tabular-nums" id="meta-last">—</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Activity</div>
  </div>
  <div class="py-2.5 ml-auto flex items-center shrink-0">
    <span id="thinking-badge" style="display:none" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 border border-zinc-200 rounded-full px-2.5 py-1">
      <span class="w-1.5 h-1.5 rounded-full bg-violet-400 block shrink-0"></span>
      Extended thinking
    </span>
  </div>
</div>

<!-- Context blocks -->
<div class="p-4 space-y-1">
  <p class="text-[10px] font-semibold text-zinc-400 cw-muted uppercase tracking-widest mb-3">Context blocks</p>
  <div id="stacked-blocks" class="space-y-1"></div>
</div>

<!-- Bottom cards -->
<div class="px-4 pb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <h3 class="text-[10px] font-bold text-zinc-400 cw-muted uppercase tracking-widest mb-3">By type</h3>
    <div id="type-breakdown" class="space-y-2.5"></div>
  </div>
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <h3 class="text-[10px] font-bold text-zinc-400 cw-muted uppercase tracking-widest mb-3">Token growth</h3>
    <canvas id="sparkline" height="60" class="w-full rounded bg-zinc-50 block"></canvas>
    <p class="text-[10px] text-zinc-300 cw-submuted mt-1">Orange dashes = 150k compaction threshold</p>
  </div>
</div>

<!-- Hidden elements kept for JS compat -->
<div id="context-map" style="display:none"></div>
<div id="notable-items" style="display:none"></div>

<script>
const TYPE_COLORS = {
  system: '#8b5cf6',
  skill_prompt: '#ec4899',
  memory: '#10b981',
  user: '#3b82f6',
  assistant: '#f59e0b',
  tool_result: '#a1a1aa',
};
const TYPE_LABELS = {
  system: 'System',
  skill_prompt: 'Skill',
  memory: 'Memory',
  user: 'User',
  assistant: 'Assistant',
  tool_result: 'Tool',
};

let ws = null;
let currentSessionId = null;
let reconnectTimer = null;

function fmt(n) {
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

function connect(sessionId) {
  if (ws) { ws.close(); ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = \`\${proto}//\${location.host}/ws\${sessionId ? '?session=' + sessionId : ''}\`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById('map-loading')?.remove();
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'sessions') {
      populateSessions(data.sessions, data.active);
    } else if (data.type === 'stats') {
      renderStats(data.stats);
    }
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(() => connect(currentSessionId), 3000);
  };
}

function populateSessions(sessions, active) {
  const sel = document.getElementById('session-select');
  sel.innerHTML = sessions.map(s =>
    \`<option value="\${s.id}" \${s.id === active ? 'selected' : ''}>\${s.id.slice(0,8)}… (\${new Date(s.mtime).toLocaleTimeString()})</option>\`
  ).join('');
  if (!currentSessionId && active) {
    currentSessionId = active;
  }
}

function selectSession(id) {
  currentSessionId = id;
  connect(id);
}

function fmtDuration(ms) {
  if (ms < 60000) return Math.round(ms/1000) + 's';
  if (ms < 3600000) return Math.round(ms/60000) + 'm';
  return (ms/3600000).toFixed(1) + 'h';
}

function fmtAgo(isoStr) {
  if (!isoStr) return '—';
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 5000) return 'just now';
  return fmtDuration(ms) + ' ago';
}

function renderStats(s) {
  document.getElementById('model-name').textContent = s.model;
  document.getElementById('turn-count').textContent = s.turns ? s.turns.length : s.blocks.filter(b => b.type === 'user').length;
  document.getElementById('stat-used').textContent = s.tokensUsed.toLocaleString();
  document.getElementById('stat-remaining').textContent = s.tokensRemaining.toLocaleString();
  document.getElementById('stat-pct').textContent = s.capacityPct.toFixed(1) + '%';
  document.getElementById('stat-blocks').textContent = s.contentBlocks;

  const fill = document.getElementById('capacity-fill');
  fill.style.width = s.capacityPct + '%';
  document.getElementById('capacity-label').textContent = s.capacityPct.toFixed(1) + '%';

  const banner = document.getElementById('compaction-banner');
  banner.style.display = s.compactionWarning ? 'flex' : 'none';

  document.getElementById('meta-cache').textContent = s.cacheHitPct + '%';
  document.getElementById('meta-cost').textContent = '$' + s.estimatedCostUsd.toFixed(4);
  if (s.sessionStartedAt && s.sessionLastActivityAt) {
    const dur = new Date(s.sessionLastActivityAt) - new Date(s.sessionStartedAt);
    document.getElementById('meta-duration').textContent = fmtDuration(dur);
  }
  document.getElementById('meta-last').textContent = fmtAgo(s.sessionLastActivityAt);
  const thinkingBadge = document.getElementById('thinking-badge');
  thinkingBadge.style.display = s.hasThinking ? 'flex' : 'none';

  renderStackedBlocks(s.blocks);
  renderSparkline(s.turns || []);
  renderTypeBreakdown(s.byType, s.tokensUsed);
}

function renderSparkline(turns) {
  const canvas = document.getElementById('sparkline');
  if (!canvas || !turns.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 300;
  canvas.width = W;
  const H = 60;
  ctx.clearRect(0, 0, W, H);

  const values = turns.map(t => t.inputTokens);
  const max = Math.max(...values, 1);
  const step = W / Math.max(values.length - 1, 1);

  ctx.beginPath();
  ctx.moveTo(0, H);
  values.forEach((v, i) => ctx.lineTo(i * step, H - (v / max) * (H - 6) - 2));
  ctx.lineTo((values.length - 1) * step, H);
  ctx.closePath();
  const dk = document.documentElement.classList.contains('dark');
  ctx.fillStyle = dk ? 'rgba(161,161,170,0.08)' : 'rgba(63,63,70,0.06)';
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = H - (v / max) * (H - 6) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = dk ? '#a1a1aa' : '#3f3f46';
  ctx.lineWidth = 2;
  ctx.stroke();

  const threshY = H - (150000 / max) * (H - 6) - 2;
  if (threshY > 0 && threshY < H) {
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(0, threshY);
    ctx.lineTo(W, threshY);
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function renderStackedBlocks(blocks) {
  const container = document.getElementById('stacked-blocks');
  container.innerHTML = '';
  if (!blocks.length) {
    container.innerHTML = '<p style="font-size:12px;color:#a1a1aa;padding:16px 0;text-align:center">No context blocks yet</p>';
    return;
  }

  const maxTok = Math.max(...blocks.map(b => b.tokens), 1);
  const MIN_H = 24;
  const MAX_H = 80;
  const logMax = Math.log(maxTok + 1);
  function blockH(tokens) {
    return Math.round(MIN_H + (Math.log(tokens + 1) / logMax) * (MAX_H - MIN_H));
  }

  const reversed = [...blocks].reverse();
  for (const b of reversed) {
    const h = blockH(b.tokens);
    const color = TYPE_COLORS[b.type] || '#a1a1aa';
    const label = TYPE_LABELS[b.type] || b.type;
    const div = document.createElement('div');
    div.title = \`\${b.label} — \${b.tokens.toLocaleString()} tokens\`;
    const isDark = document.documentElement.classList.contains('dark');
    const bgColor = isDark ? '#27272a' : 'white';
    const bgHover = isDark ? '#3f3f46' : '#fafafa';
    const bColor = isDark ? '#3f3f46' : '#f4f4f5';
    div.style.cssText = \`display:flex;align-items:center;gap:12px;border-left:3px solid \${color};background:\${bgColor};border-radius:0 6px 6px 0;padding:0 12px;height:\${h}px;border:1px solid \${bColor};border-left-width:3px;border-left-color:\${color};cursor:default;transition:background 0.1s\`;
    div.onmouseenter = () => div.style.background = bgHover;
    div.onmouseleave = () => div.style.background = bgColor;
    if (h >= 28) {
      div.innerHTML = \`
        <span style="font-size:10px;font-weight:700;color:\${color};text-transform:uppercase;letter-spacing:0.06em;width:64px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(label)}</span>
        <span style="font-size:13px;color:#3f3f46;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(b.label)}</span>
        <span style="font-size:11px;color:#a1a1aa;font-variant-numeric:tabular-nums;flex-shrink:0">\${b.tokens.toLocaleString()}</span>\`;
    } else {
      div.innerHTML = \`
        <span style="font-size:10px;font-weight:700;color:\${color};text-transform:uppercase;letter-spacing:0.06em;width:64px;flex-shrink:0">\${escHtml(label)}</span>
        <span style="font-size:11px;color:#a1a1aa;font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:auto">\${b.tokens.toLocaleString()}</span>\`;
    }
    container.appendChild(div);
  }
}

function renderTypeBreakdown(byType, total) {
  const el = document.getElementById('type-breakdown');
  const maxVal = Math.max(...Object.values(byType), 1);
  el.innerHTML = Object.entries(byType)
    .filter(([, tokens]) => tokens > 0)
    .map(([type, tokens]) => {
      const color = TYPE_COLORS[type] || '#a1a1aa';
      const pct = (tokens / maxVal * 100).toFixed(1);
      const dk = document.documentElement.classList.contains('dark');
      const barBg = dk ? '#3f3f46' : '#f4f4f5';
      const barFill = dk ? '#e4e4e7' : '#3f3f46';
      const countColor = dk ? '#a1a1aa' : '#52525b';
      return \`<div style="display:flex;align-items:center;gap:10px">
        <span style="width:6px;height:6px;border-radius:50%;background:\${color};flex-shrink:0;display:block"></span>
        <span style="font-size:11px;color:#71717a;width:64px;flex-shrink:0">\${TYPE_LABELS[type] || type}</span>
        <div style="flex:1;height:4px;background:\${barBg};border-radius:99px;overflow:hidden">
          <div style="height:100%;background:\${barFill};border-radius:99px;width:\${pct}%"></div>
        </div>
        <span style="font-size:11px;font-weight:500;color:\${countColor};width:40px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0">\${fmt(tokens)}</span>
      </div>\`;
    }).join('');
}

function toggleDark() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('cw-dark', isDark ? '1' : '0');
  document.getElementById('dark-icon').textContent = isDark ? '🌙' : '☀️';
}

document.addEventListener('DOMContentLoaded', () => {
  const isDark = document.documentElement.classList.contains('dark');
  const icon = document.getElementById('dark-icon');
  if (icon) icon.textContent = isDark ? '🌙' : '☀️';
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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

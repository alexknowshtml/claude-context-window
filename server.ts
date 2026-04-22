#!/usr/bin/env bun
/**
 * Live Context Window Visualizer
 * Watches active Claude Code session transcripts and serves a real-time
 * breakdown of token usage by content type.
 *
 * Port: 2670
 * Usage: bun run scripts/context-window-server.ts
 */

import { watch } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PORT = 3456;
const PROJECTS_DIR = join(homedir(), ".claude/projects/-home-alexhillman-andy");
const MODEL_LIMIT = 200_000;

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

interface StartingContextEntry {
  label: string;
  tokens: number;
  path?: string;
  warning?: string;
}

interface StartingContextBreakdown {
  total: number;
  entries: StartingContextEntry[];
}

interface MemoryFileEntry {
  name: string;
  path: string;
  tokens: number;
  lines: number;
  type: string; // "user" | "feedback" | "project" | "reference" | "other"
  warning?: string;
}

interface MemoryHealth {
  totalFiles: number;
  totalTokens: number;
  indexLines: number;
  indexLineLimit: number;
  files: MemoryFileEntry[];
}

interface WasteItem {
  type: "duplicate_read" | "large_result" | "unread_skill";
  label: string;
  tokens: number;
  detail: string;
}

interface WasteReport {
  items: WasteItem[];
  totalWasteTokens: number;
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
  startingContext: StartingContextBreakdown;
  memoryHealth: MemoryHealth;
  wasteReport: WasteReport;
}

// ~3.5 chars per token approximation
function estTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}

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
      text.includes("memory/user_") ||
      text.includes("memory/feedback_") ||
      text.includes("memory/reference_")
    )
      return "memory";
  }
  return "tool_result";
}

async function computeMemoryHealth(): Promise<MemoryHealth> {
  const MEMORY_DIR = join(PROJECTS_DIR, "memory");
  const INDEX_LINE_LIMIT = 200;

  let indexLines = 0;
  try {
    const idx = await readFile(join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    indexLines = idx.split("\n").length;
  } catch { /* ignore */ }

  let files: MemoryFileEntry[] = [];
  try {
    const entries = await readdir(MEMORY_DIR);
    const mdFiles = entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    files = await Promise.all(
      mdFiles.map(async (fname) => {
        const fpath = join(MEMORY_DIR, fname);
        const content = await readFile(fpath, "utf-8").catch(() => "");
        const tokens = estTokens(content);
        const lines = content.split("\n").length;
        // infer type from filename prefix
        const typeMatch = fname.match(/^(user|feedback|project|reference)_/);
        const type = typeMatch ? typeMatch[1] : "other";
        let warning: string | undefined;
        if (tokens > 1500) warning = `${tokens.toLocaleString()} tokens — consider summarizing`;
        else if (tokens > 800) warning = `${tokens.toLocaleString()} tokens — getting large`;
        return { name: fname.replace(/\.md$/, ""), path: fpath, tokens, lines, type, warning };
      })
    );
    files.sort((a, b) => b.tokens - a.tokens);
  } catch { /* ignore */ }

  return {
    totalFiles: files.length,
    totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    indexLines,
    indexLineLimit: INDEX_LINE_LIMIT,
    files,
  };
}

function computeWasteReport(blocks: ContextBlock[]): WasteReport {
  const items: WasteItem[] = [];

  // Detect duplicate reads: same specific label appearing multiple times
  // Skip generic labels (e.g. "Read result", "Bash result") — those are different files
  const GENERIC_LABELS = /^(Read|Bash|Edit|Write|Glob|Grep|TodoWrite|Agent)\b/;
  const readCounts = new Map<string, { count: number; tokens: number }>();
  for (const b of blocks) {
    if (b.type === "memory" || b.type === "skill_prompt") {
      const key = b.label;
      if (GENERIC_LABELS.test(key)) continue;
      const existing = readCounts.get(key);
      if (existing) {
        existing.count++;
        existing.tokens += b.tokens;
      } else {
        readCounts.set(key, { count: 1, tokens: b.tokens });
      }
    }
  }
  for (const [label, { count, tokens }] of readCounts) {
    if (count > 1) {
      items.push({
        type: "duplicate_read",
        label,
        tokens,
        detail: `Read ${count}× in this session`,
      });
    }
  }

  // Detect large single skill/memory loads (> 4k tokens)
  for (const b of blocks) {
    if (
      (b.type === "skill_prompt" || b.type === "memory") &&
      b.tokens > 4000 &&
      !readCounts.get(b.label)
    ) {
      items.push({
        type: "large_result",
        label: b.label,
        tokens: b.tokens,
        detail: `${b.tokens.toLocaleString()} token result — consider truncation or summarization`,
      });
    }
  }

  // Sort by token waste desc
  items.sort((a, b) => b.tokens - a.tokens);

  return {
    items,
    totalWasteTokens: items.reduce((s, i) => s + i.tokens, 0),
  };
}

async function readStartingContextFiles(): Promise<StartingContextEntry[]> {
  const MEMORY_DIR = join(PROJECTS_DIR, "memory");
  const candidates = [
    { label: "CLAUDE.md (global)", path: join(homedir(), ".claude/CLAUDE.md") },
    { label: "CLAUDE.md (project)", path: join(homedir(), "andy/CLAUDE.md") },
    { label: "MEMORY.md (index)", path: join(MEMORY_DIR, "MEMORY.md") },
  ];

  const results: StartingContextEntry[] = [];
  for (const f of candidates) {
    try {
      const content = await readFile(f.path, "utf-8");
      const tokens = estTokens(content);
      let warning: string | undefined;
      if (f.label.includes("MEMORY.md")) {
        const lines = content.split("\n").length;
        if (lines > 200) warning = `${lines} lines (limit: 200) — tail entries may be truncated`;
      }
      if (f.label.includes("CLAUDE.md") && tokens > 3000) {
        warning = `${tokens.toLocaleString()} tokens — consider moving sections to on-demand includes`;
      }
      results.push({ label: f.label, path: f.path, tokens, warning });
    } catch {
      // file unreadable — skip
    }
  }
  return results;
}

async function findActiveSessions(): Promise<
  Array<{ id: string; mtime: number }>
> {
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

async function parseSession(sessionId: string): Promise<SessionStats> {
  const filePath = join(PROJECTS_DIR, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return emptyStats(sessionId);
  }

  const [startingContextFiles, memoryHealth] = await Promise.all([
    readStartingContextFiles(),
    computeMemoryHealth(),
  ]);

  const lines = raw
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  const blocks: ContextBlock[] = [];
  const skills: string[] = [];
  const turns: TurnStat[] = [];
  let latestUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
  };
  let model = "claude-sonnet-4-6";
  let sessionStartedAt: string | undefined;
  let sessionLastActivityAt: string | undefined;
  let sessionHasThinking = false;

  // Track tool_use name by id so we can classify tool_result blocks
  const toolUseNames: Map<string, string> = new Map();
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

      // System-reminder blocks (injected into first user message)
      if (typeof content === "string") {
        const sysBlocks =
          content.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) ?? [];
        for (const sb of sysBlocks) {
          blocks.push({ type: "system", label: "System Context", tokens: estTokens(sb) });
        }
        // Real user message
        const userMsg = content.match(/\*\*Message:\*\* (.+)/)?.[1];
        if (userMsg) {
          blocks.push({
            type: "user",
            label: `User: "${userMsg.slice(0, 60)}"`,
            tokens: estTokens(userMsg),
          });
        } else if (!content.includes("[ANDY-INTERNAL-TASK]")) {
          blocks.push({
            type: "user",
            label: `User: "${content.slice(0, 60)}"`,
            tokens: estTokens(content),
          });
        }
      }

      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          const bt = block.type as string;

          if (bt === "tool_result") {
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

            let label = "Tool Result";
            if (bType === "skill_prompt") {
              const m = resultText.match(/skills\/([a-z-]+)\//);
              const skillName = m?.[1] ?? "skill";
              label = `${skillName} SKILL.md`;
              if (!skills.includes(skillName)) skills.push(skillName);
            } else if (bType === "memory") {
              const m = resultText.match(/memory\/([^.]+)\.md/);
              label = m ? `memory/${m[1]}` : "Memory file";
            } else if (toolName) {
              label = `${toolName} result`;
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

      const msgContent = msg.content as Record<string, unknown>[] | undefined;
      let turnHasThinking = false;

      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          const bt = block.type as string;
          if (bt === "thinking") {
            turnHasThinking = true;
            sessionHasThinking = true;
          }
          if (bt === "text" && block.text) {
            const text = block.text as string;
            blocks.push({
              type: "assistant",
              label: `Assistant: "${text.slice(0, 60).replace(/\n/g, " ")}"`,
              tokens: estTokens(text),
            });
          }
          if (bt === "tool_use") {
            const toolId = block.id as string;
            const toolName = block.name as string;
            if (toolId && toolName) toolUseNames.set(toolId, toolName);

            const inputStr = JSON.stringify(block.input ?? {});
            blocks.push({
              type: "tool_result",
              label: `${toolName}(${Object.keys(
                (block.input as Record<string, unknown>) ?? {}
              )
                .slice(0, 2)
                .join(", ")})`,
              tokens: estTokens(inputStr),
            });
          }
        }
      }

      // Record this turn's stats
      if (usage) {
        turns.push({
          turn: turns.length + 1,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreate: usage.cache_creation_input_tokens ?? 0,
          hasThinking: turnHasThinking,
          timestamp,
        });
      }
    }
  }

  // Infer system layer from first-call cache creation tokens.
  // The first cache_creation batch = base system prompt (CLAUDE.md, tool schemas,
  // skill catalog, memory) + first user message. Subtract parsed user/tool content
  // to isolate the system prompt size, then prepend a synthetic block.
  let startingContext: StartingContextBreakdown = { total: firstAssistantCacheCreate, entries: [] };
  if (firstAssistantCacheCreate > 0) {
    const parsedBeforeFirstAssistant = blocks
      .filter((b) => b.type === "user" || b.type === "system")
      .reduce((sum, b) => sum + b.tokens, 0);
    const inferredSystem = Math.max(0, firstAssistantCacheCreate - parsedBeforeFirstAssistant);
    if (inferredSystem > 500) {
      blocks.unshift({
        type: "system",
        label: "Base system prompt (CLAUDE.md + tool schemas + skill catalog)",
        tokens: inferredSystem,
      });
    }

    // Build starting context breakdown
    const measuredTotal = startingContextFiles.reduce((s, f) => s + f.tokens, 0);
    const parsedSystemReminders = blocks
      .filter((b) => b.type === "system" && b.label === "System Context")
      .reduce((s, b) => s + b.tokens, 0);
    const toolSchemaTokens = Math.max(
      0,
      firstAssistantCacheCreate - measuredTotal - parsedSystemReminders - parsedBeforeFirstAssistant
    );
    startingContext = {
      total: firstAssistantCacheCreate,
      entries: [
        { label: "Tool schemas + skill catalog", tokens: toolSchemaTokens },
        ...startingContextFiles,
        ...(parsedSystemReminders > 0
          ? [{ label: "Session context (hooks, env, beads)", tokens: parsedSystemReminders }]
          : []),
      ].filter((e) => e.tokens > 0),
    };
  }

  const wasteReport = computeWasteReport(blocks);

  // Compute token totals by type
  const byType: Record<BlockType, number> = {
    system: 0,
    skill_prompt: 0,
    memory: 0,
    user: 0,
    assistant: 0,
    tool_result: 0,
  };
  for (const b of blocks) byType[b.type] += b.tokens;

  const totalEstimated = Object.values(byType).reduce((a, b) => a + b, 0);

  // Use actual API usage if available, otherwise fall back to estimate
  const tokensUsed =
    latestUsage.input + latestUsage.cacheRead + latestUsage.cacheCreate > 0
      ? latestUsage.input + latestUsage.cacheRead + latestUsage.cacheCreate
      : totalEstimated;

  const tokensRemaining = Math.max(0, MODEL_LIMIT - tokensUsed);
  const capacityPct = Math.min(100, (tokensUsed / MODEL_LIMIT) * 100);

  // Cache hit rate
  const totalCacheTokens = latestUsage.cacheRead + latestUsage.cacheCreate;
  const cacheHitPct = totalCacheTokens > 0
    ? Math.round((latestUsage.cacheRead / totalCacheTokens) * 100)
    : 0;

  // Cost estimate (claude-sonnet-4-6 pricing per 1M tokens)
  const PRICE = { input: 3.0, cacheWrite: 3.75, cacheRead: 0.30, output: 15.0 };
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
    startingContext,
    memoryHealth,
    wasteReport,
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
    contentBlocks: 0,
    skillsLoaded: [],
    blocks: [],
    byType: { system: 0, skill_prompt: 0, memory: 0, user: 0, assistant: 0, tool_result: 0 },
    turns: [],
    hasThinking: false,
    cacheHitPct: 0,
    estimatedCostUsd: 0,
    compactionWarning: false,
    updatedAt: new Date().toISOString(),
    startingContext: { total: 0, entries: [] },
    memoryHealth: { totalFiles: 0, totalTokens: 0, indexLines: 0, indexLineLimit: 200, files: [] },
    wasteReport: { items: [], totalWasteTokens: 0 },
  };
}

// ─── HTML Frontend ──────────────────────────────────────────────────────────

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
  .hidden { display: none !important; }
  #mem-file-list { scrollbar-width: thin; }
</style>
<script>
  // Apply saved dark mode before render to avoid flash
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
        <span class="text-lg text-zinc-400 cw-muted font-medium tabular-nums">200,000</span>
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
  ⚠️ Approaching context limit — consider running <code class="bg-orange-100 rounded px-1.5 py-0.5 font-mono">/pause</code> to save state
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
  <div class="py-2.5 pr-5 mr-5 border-r cw-border-r border-zinc-100 shrink-0 hidden" id="stat-skills-wrap">
    <div class="text-sm font-semibold tabular-nums" id="stat-skills">—</div>
    <div class="text-[10px] text-zinc-400 cw-muted uppercase tracking-wider font-medium mt-0.5">Skills</div>
  </div>
  <div class="py-2.5 ml-auto flex items-center shrink-0">
    <span id="thinking-badge" style="display:none" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 border border-zinc-200 rounded-full px-2.5 py-1">
      <span class="w-1.5 h-1.5 rounded-full bg-violet-400 block shrink-0"></span>
      Extended thinking
    </span>
  </div>
</div>

<!-- Top cards: By type + Token growth -->
<div class="px-4 pt-4 pb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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

<!-- Starting Context Breakdown -->
<div class="px-4 pb-6" id="starting-ctx-section" style="display:none">
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <h3 class="text-[10px] font-bold text-zinc-400 cw-muted uppercase tracking-widest mb-1">Starting context breakdown</h3>
    <p class="text-[10px] text-zinc-300 cw-submuted mb-3">Tokens consumed before the first user message</p>
    <div id="starting-ctx-entries" class="space-y-2.5"></div>
    <div id="starting-ctx-warnings" class="mt-3 space-y-1.5"></div>
  </div>
</div>

<!-- Memory Health -->
<div class="px-4 pb-6" id="memory-health-section" style="display:none">
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <div class="flex items-center justify-between mb-1">
      <h3 class="text-[10px] font-bold text-zinc-400 cw-muted uppercase tracking-widest">Memory health</h3>
      <span class="text-[10px] text-zinc-400 cw-muted" id="mem-summary"></span>
    </div>
    <p class="text-[10px] text-zinc-300 cw-submuted mb-3">All files in <code>~/.claude/projects/.../memory/</code> sorted by token cost</p>
    <div id="mem-index-warning" class="mb-3 hidden"></div>
    <div id="mem-file-list" class="space-y-1.5 max-h-64 overflow-y-auto"></div>
  </div>
</div>

<!-- Session Waste -->
<div class="px-4 pb-6" id="waste-section" style="display:none">
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <div class="flex items-center justify-between mb-1">
      <h3 class="text-[10px] font-bold text-zinc-400 cw-muted uppercase tracking-widest">Session waste</h3>
      <span class="text-[10px] text-zinc-400 cw-muted" id="waste-summary"></span>
    </div>
    <p class="text-[10px] text-zinc-300 cw-submuted mb-3">Duplicate reads, oversized results, and refactoring candidates</p>
    <div id="waste-items" class="space-y-2"></div>
    <p id="waste-empty" class="text-xs text-zinc-400 cw-muted text-center py-4" style="display:none">No obvious waste detected in this session</p>
  </div>
</div>

<!-- Context blocks (scrollable) -->
<div class="px-4 pb-6">
  <div class="bg-white cw-panel border border-zinc-200 rounded-lg p-4">
    <p class="text-[10px] font-semibold text-zinc-400 cw-muted uppercase tracking-widest mb-3">Context blocks</p>
    <div id="stacked-blocks" class="space-y-1 max-h-96 overflow-y-auto pr-1" style="scrollbar-width:thin"></div>
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
  lastStats = s;
  document.getElementById('model-name').textContent = s.model;
  document.getElementById('turn-count').textContent = s.turns ? s.turns.length : s.blocks.filter(b => b.type === 'user').length;
  document.getElementById('stat-used').textContent = s.tokensUsed.toLocaleString();
  document.getElementById('stat-remaining').textContent = s.tokensRemaining.toLocaleString();
  document.getElementById('stat-pct').textContent = s.capacityPct.toFixed(1) + '%';
  document.getElementById('stat-blocks').textContent = s.contentBlocks;
  document.getElementById('stat-skills').textContent = s.skillsLoaded.length;

  const fill = document.getElementById('capacity-fill');
  fill.style.width = s.capacityPct + '%';
  document.getElementById('capacity-label').textContent = s.capacityPct.toFixed(1) + '%';

  // Compaction warning
  const banner = document.getElementById('compaction-banner');
  banner.style.display = s.compactionWarning ? 'flex' : 'none';

  // Meta bar
  document.getElementById('meta-cache').textContent = s.cacheHitPct + '%';
  document.getElementById('meta-cost').textContent = '$' + s.estimatedCostUsd.toFixed(4);
  if (s.sessionStartedAt && s.sessionLastActivityAt) {
    const dur = new Date(s.sessionLastActivityAt) - new Date(s.sessionStartedAt);
    document.getElementById('meta-duration').textContent = fmtDuration(dur);
  }
  document.getElementById('meta-last').textContent = fmtAgo(s.sessionLastActivityAt);
  const thinkingBadge = document.getElementById('thinking-badge');
  thinkingBadge.style.display = s.hasThinking ? 'flex' : 'none';

  renderContextMap(s.blocks);
  renderStackedBlocks(s.blocks);
  renderSparkline(s.turns || []);
  renderTypeBreakdown(s.byType, s.tokensUsed);
  renderStartingContext(s.startingContext);
  renderMemoryHealth(s.memoryHealth);
  renderWasteReport(s.wasteReport);
  renderNotable(s);
}

function renderSparkline(turns) {
  const canvas = document.getElementById('sparkline');
  if (!canvas || !turns.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 300;
  canvas.width = W;
  const H = 60;
  ctx.clearRect(0, 0, W, H);

  const dk = document.documentElement.classList.contains('dark');
  const lineColor = dk ? '#a1a1aa' : '#3f3f46';
  const fillColor = dk ? 'rgba(161,161,170,0.08)' : 'rgba(63,63,70,0.06)';

  const values = turns.map(t => t.inputTokens);
  const max = Math.max(...values, 1);
  const step = W / Math.max(values.length - 1, 1);

  // Fill area
  ctx.beginPath();
  ctx.moveTo(0, H);
  values.forEach((v, i) => {
    const x = i * step;
    const y = H - (v / max) * (H - 6) - 2;
    if (i === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo((values.length - 1) * step, H);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Line
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = H - (v / max) * (H - 6) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Compaction threshold line at 150k
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

function renderContextMap(blocks) {
  // no-op: #context-map is hidden
}

function renderStackedBlocks(blocks) {
  const container = document.getElementById('stacked-blocks');
  container.innerHTML = '';
  if (!blocks.length) {
    container.innerHTML = '<p class="text-xs text-zinc-400 py-4 text-center">No context blocks yet</p>';
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
    const textColor = isDark ? '#d4d4d8' : '#3f3f46';
    const mutedColor = isDark ? '#a1a1aa' : '#a1a1aa';
    div.style.cssText = \`display:flex;align-items:center;gap:12px;border-left:3px solid \${color};background:\${bgColor};border-radius:0 6px 6px 0;padding:0 12px;height:\${h}px;border:1px solid \${bColor};border-left-width:3px;border-left-color:\${color};cursor:default;transition:background 0.1s\`;
    div.onmouseenter = () => div.style.background = bgHover;
    div.onmouseleave = () => div.style.background = bgColor;
    if (h >= 28) {
      div.innerHTML = \`
        <span style="font-size:10px;font-weight:700;color:\${color};text-transform:uppercase;letter-spacing:0.06em;width:64px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(label)}</span>
        <span style="font-size:13px;color:\${textColor};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(b.label)}</span>
        <span style="font-size:11px;color:\${mutedColor};font-variant-numeric:tabular-nums;flex-shrink:0">\${b.tokens.toLocaleString()}</span>\`;
    } else {
      div.innerHTML = \`
        <span style="font-size:10px;font-weight:700;color:\${color};text-transform:uppercase;letter-spacing:0.06em;width:64px;flex-shrink:0">\${escHtml(label)}</span>
        <span style="font-size:11px;color:\${mutedColor};font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:auto">\${b.tokens.toLocaleString()}</span>\`;
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
      const labelColor = dk ? '#71717a' : '#71717a';
      const barBg = dk ? '#3f3f46' : '#f4f4f5';
      const barFill = dk ? '#e4e4e7' : '#3f3f46';
      const countColor = dk ? '#a1a1aa' : '#52525b';
      return \`<div style="display:flex;align-items:center;gap:10px">
        <span style="width:6px;height:6px;border-radius:50%;background:\${color};flex-shrink:0;display:block"></span>
        <span style="font-size:11px;color:\${labelColor};width:64px;flex-shrink:0">\${TYPE_LABELS[type] || type}</span>
        <div style="flex:1;height:4px;background:\${barBg};border-radius:99px;overflow:hidden">
          <div style="height:100%;background:\${barFill};border-radius:99px;width:\${pct}%"></div>
        </div>
        <span style="font-size:11px;font-weight:500;color:\${countColor};width:40px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0">\${fmt(tokens)}</span>
      </div>\`;
    }).join('');
}

function renderMemoryHealth(mh) {
  const section = document.getElementById('memory-health-section');
  if (!mh || !mh.totalFiles) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const dk = document.documentElement.classList.contains('dark');
  const labelColor = dk ? '#a1a1aa' : '#52525b';
  const mutedColor = dk ? '#71717a' : '#a1a1aa';
  const warnColor = '#f59e0b';
  const dangerColor = '#ef4444';

  document.getElementById('mem-summary').textContent =
    \`\${mh.totalFiles} files · \${fmt(mh.totalTokens)} tokens total\`;

  const indexWarn = document.getElementById('mem-index-warning');
  if (mh.indexLines > mh.indexLineLimit) {
    indexWarn.className = '';
    indexWarn.innerHTML = \`<div style="font-size:11px;color:\${dangerColor};display:flex;gap:6px;align-items:flex-start;margin-bottom:8px">
      <span>🔴</span><span>MEMORY.md is <strong>\${mh.indexLines} lines</strong> (limit: \${mh.indexLineLimit}) — entries past line \${mh.indexLineLimit} are not loaded into context</span>
    </div>\`;
  } else {
    indexWarn.className = 'hidden';
  }

  const TYPE_COLORS_MEM = { user: '#3b82f6', feedback: '#ec4899', project: '#f59e0b', reference: '#10b981', other: '#a1a1aa' };
  const list = document.getElementById('mem-file-list');
  const maxTok = Math.max(...mh.files.map(f => f.tokens), 1);
  list.innerHTML = mh.files.slice(0, 50).map(f => {
    const color = TYPE_COLORS_MEM[f.type] || '#a1a1aa';
    const barBg = dk ? '#3f3f46' : '#f4f4f5';
    const barPct = (f.tokens / maxTok * 100).toFixed(1);
    const warnIcon = f.tokens > 1500 ? '🔴' : f.tokens > 800 ? '🟡' : '';
    return \`<div style="display:flex;align-items:center;gap:8px">
      <span style="width:5px;height:5px;border-radius:50%;background:\${color};flex-shrink:0"></span>
      <span style="font-size:10px;color:\${mutedColor};width:64px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.04em">\${escHtml(f.type)}</span>
      <span style="font-size:11px;color:\${labelColor};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="\${escHtml(f.name)}">\${escHtml(f.name.replace(/^(user|feedback|project|reference)_/, ''))}</span>
      <div style="width:60px;height:3px;background:\${barBg};border-radius:99px;overflow:hidden;flex-shrink:0">
        <div style="height:100%;background:\${color};border-radius:99px;width:\${barPct}%"></div>
      </div>
      <span style="font-size:11px;color:\${mutedColor};width:36px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0">\${fmt(f.tokens)}</span>
      \${warnIcon ? \`<span style="flex-shrink:0;font-size:10px">\${warnIcon}</span>\` : '<span style="width:13px;flex-shrink:0"></span>'}
    </div>\`;
  }).join('');
}

function renderWasteReport(wr) {
  const section = document.getElementById('waste-section');
  if (!wr) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const dk = document.documentElement.classList.contains('dark');
  const labelColor = dk ? '#d4d4d8' : '#3f3f46';
  const mutedColor = dk ? '#71717a' : '#a1a1aa';

  document.getElementById('waste-summary').textContent =
    wr.totalWasteTokens > 0 ? \`~\${fmt(wr.totalWasteTokens)} tokens recoverable\` : 'Clean';

  const itemsEl = document.getElementById('waste-items');
  const emptyEl = document.getElementById('waste-empty');

  if (!wr.items.length) {
    itemsEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  const TYPE_ICONS = { duplicate_read: '♻️', large_result: '📦', unread_skill: '💤' };
  const TYPE_COLOR = { duplicate_read: '#f59e0b', large_result: '#ef4444', unread_skill: '#a1a1aa' };

  itemsEl.innerHTML = wr.items.map(item => {
    const color = TYPE_COLOR[item.type] || '#a1a1aa';
    const icon = TYPE_ICONS[item.type] || '⚠️';
    return \`<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid \${dk ? '#3f3f46' : '#f4f4f5'}">
      <span style="font-size:12px;flex-shrink:0">\${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:\${labelColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(item.label)}</div>
        <div style="font-size:11px;color:\${mutedColor};margin-top:1px">\${escHtml(item.detail)}</div>
      </div>
      <span style="font-size:11px;font-weight:600;color:\${color};flex-shrink:0;font-variant-numeric:tabular-nums">\${fmt(item.tokens)}</span>
    </div>\`;
  }).join('');
}

function renderNotable(s) {
  // no-op: #notable-items is hidden
}

function renderStartingContext(sc) {
  const section = document.getElementById('starting-ctx-section');
  if (!sc || !sc.entries || !sc.entries.length || sc.total === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const total = sc.total || 1;
  const dk = document.documentElement.classList.contains('dark');
  const labelColor = dk ? '#71717a' : '#71717a';
  const countColor = dk ? '#a1a1aa' : '#52525b';
  const barBg = dk ? '#3f3f46' : '#f4f4f5';
  const panelBg = dk ? '#27272a' : 'white';

  const ENTRY_COLORS = [
    ['Tool schemas', '#6366f1'],
    ['CLAUDE.md (global)', '#f59e0b'],
    ['CLAUDE.md (project)', '#f97316'],
    ['MEMORY.md', '#10b981'],
    ['Session context', '#3b82f6'],
  ];
  function colorFor(label) {
    const match = ENTRY_COLORS.find(([k]) => label.includes(k));
    return match ? match[1] : '#a1a1aa';
  }

  const entries = document.getElementById('starting-ctx-entries');
  entries.innerHTML = sc.entries.map(e => {
    const pct = Math.min((e.tokens / total * 100), 100);
    const pctStr = pct.toFixed(1);
    const color = colorFor(e.label);
    return \`<div style="display:flex;align-items:center;gap:10px" title="\${escHtml(e.path||e.label)}">
      <span style="width:6px;height:6px;border-radius:50%;background:\${color};flex-shrink:0;display:block"></span>
      <span style="font-size:11px;color:\${labelColor};width:190px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${escHtml(e.label)}</span>
      <div style="flex:1;height:4px;background:\${barBg};border-radius:99px;overflow:hidden">
        <div style="height:100%;background:\${color};border-radius:99px;width:\${pctStr}%"></div>
      </div>
      <span style="font-size:11px;font-weight:500;color:\${countColor};width:44px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0">\${fmt(e.tokens)}</span>
      <span style="font-size:11px;color:\${labelColor};width:38px;text-align:right;flex-shrink:0">\${pctStr}%</span>
    </div>\`;
  }).join('');

  const warnings = sc.entries.filter(e => e.warning);
  const warningsEl = document.getElementById('starting-ctx-warnings');
  warningsEl.innerHTML = warnings.map(e =>
    \`<div style="font-size:11px;color:#f59e0b;display:flex;align-items:flex-start;gap:6px">
      <span style="flex-shrink:0">⚠️</span>
      <span><strong>\${escHtml(e.label)}:</strong> \${escHtml(e.warning)}</span>
    </div>\`
  ).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let lastStats = null;
function toggleDark() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('cw-dark', isDark ? '1' : '0');
  document.getElementById('dark-icon').textContent = isDark ? '🌙' : '☀️';
  if (lastStats) renderStats(lastStats);
}

// Sync icon to current state on load
document.addEventListener('DOMContentLoaded', () => {
  const isDark = document.documentElement.classList.contains('dark');
  const icon = document.getElementById('dark-icon');
  if (icon) icon.textContent = isDark ? '🌙' : '☀️';
});

// Start
connect(null);
</script>
</body>
</html>`;

// ─── WebSocket State ─────────────────────────────────────────────────────────

const clients = new Set<{
  ws: WebSocket;
  sessionId: string | null;
}>();

async function broadcastToClient(
  client: { ws: WebSocket; sessionId: string | null },
  sessions: Array<{ id: string; mtime: number }>
) {
  if (client.ws.readyState !== 1) return;

  // Send session list
  client.ws.send(
    JSON.stringify({
      type: "sessions",
      sessions: sessions.map((s) => ({ id: s.id, mtime: s.mtime })),
      active: client.sessionId ?? sessions[0]?.id ?? null,
    })
  );

  const sessionId = client.sessionId ?? sessions[0]?.id;
  if (!sessionId) return;

  const stats = await parseSession(sessionId);
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
        for (const client of clients) {
          await broadcastToClient(client, sessions);
        }
      }, 500);
    });
  } catch {
    // Watcher setup failed — polling fallback
    setInterval(async () => {
      if (clients.size === 0) return;
      const sessions = await findActiveSessions();
      for (const client of clients) {
        await broadcastToClient(client, sessions);
      }
    }, 5000);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      const sessionId = url.searchParams.get("session") || null;
      const client = { ws: null as unknown as WebSocket, sessionId };

      const upgraded = server.upgrade(req, { data: client });
      if (!upgraded) return new Response("WS upgrade failed", { status: 400 });
      return undefined as unknown as Response;
    }

    // API: session list
    if (url.pathname === "/api/sessions") {
      const sessions = await findActiveSessions();
      return new Response(JSON.stringify(sessions), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // API: session stats
    if (url.pathname.startsWith("/api/stats/")) {
      const id = url.pathname.slice("/api/stats/".length);
      const stats = await parseSession(id);
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Mockup previews
    if (url.pathname === "/mockup" || url.pathname === "/mockup-daisy" || url.pathname === "/mockup-shadcn") {
      const { readFileSync } = await import("fs");
      const file = url.pathname === "/mockup-daisy" ? "/tmp/cw-daisy.html"
        : url.pathname === "/mockup-shadcn" ? "/tmp/cw-shadcn.html"
        : "/tmp/cw-mockup.html";
      try {
        const html = readFileSync(file, "utf8");
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      } catch {
        return new Response("Mockup not found", { status: 404 });
      }
    }

    // Serve HTML
    return new Response(HTML, {
      headers: { "Content-Type": "text/html" },
    });
  },

  websocket: {
    async open(ws) {
      const client = ws.data as { ws: WebSocket; sessionId: string | null };
      client.ws = ws as unknown as WebSocket;
      clients.add(client);

      const sessions = await findActiveSessions();
      await broadcastToClient(client, sessions);
    },

    message() {
      // No client→server messages needed
    },

    close(ws) {
      const client = ws.data as { ws: WebSocket; sessionId: string | null };
      clients.delete(client);
    },
  },
});

setupWatcher();

console.log(`Context Window server running at http://localhost:${PORT}`);
console.log(`Watching: ${PROJECTS_DIR}`);

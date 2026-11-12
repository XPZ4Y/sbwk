// Read-only codebase inspection. Never executes or modifies code.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".rs", ".php", ".json", ".yml", ".yaml", ".toml", ".env", ".example"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", "vendor", "__pycache__", ".venv"]);
const MAX_FILE_BYTES = 256 * 1024;

export function deriveKeywords(incident) {
  const keywords = new Set();
  for (const segment of incident.path.split("/")) {
    const clean = segment.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    if (clean.length >= 3 && !/^\d+$/.test(clean)) keywords.add(clean);
  }
  const evidence = `${incident.responseSample ?? ""} ${incident.error?.message ?? ""}`.toLowerCase();
  for (const term of ["database", "pool", "timeout", "connection", "auth", "token", "econnrefused", "null", "undefined", "query"]) {
    if (evidence.includes(term)) keywords.add(term);
  }
  return [...keywords].slice(0, 12);
}

async function walk(root, maxFiles) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) stack.push(full); }
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext) || entry.name === ".env.example") files.push(full);
      }
    }
  }
  return files;
}

function scoreContent(content, keywords) {
  const lower = content.toLowerCase();
  const lines = lower.split("\n");
  let bestLine = -1, bestLineScore = 0, score = 0;
  const matched = new Set();
  for (const kw of keywords) if (lower.includes(kw)) { matched.add(kw); score += 1; }
  for (let i = 0; i < lines.length; i++) {
    let lineScore = 0;
    for (const kw of keywords) if (lines[i].includes(kw)) lineScore += 1;
    if (lineScore > bestLineScore) { bestLineScore = lineScore; bestLine = i; }
  }
  return { score: score + bestLineScore, line: bestLine, matched: [...matched] };
}

function snippetAround(content, lineIndex, context = 2) {
  const lines = content.split("\n");
  const start = Math.max(0, lineIndex - context);
  const end = Math.min(lines.length, lineIndex + context + 1);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n").slice(0, 1200);
}

export async function inspectCodebase(incident, opts = {}) {
  const root = opts.root ?? config.CODEBASE_PATH;
  const maxFiles = opts.maxFiles ?? config.CODEBASE_MAX_FILES;
  const maxFindings = opts.maxFindings ?? config.CODEBASE_MAX_FINDINGS;
  if (!root) return [];

  const resolvedRoot = path.resolve(root);
  try { if (!(await fs.stat(resolvedRoot)).isDirectory()) return []; } catch { return []; }

  const keywords = deriveKeywords(incident);
  if (!keywords.length) return [];

  const files = await walk(resolvedRoot, maxFiles);
  const scored = [];
  for (const file of files) {
    try {
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(file, "utf8");
      const { score, line, matched } = scoreContent(content, keywords);
      if (score <= 0 || line < 0) continue;
      const relative = path.relative(resolvedRoot, file);
      scored.push({ score, finding: { file: relative, line: line + 1, snippet: snippetAround(content, line), reason: `Matched incident keywords: ${matched.join(", ")}` } });
    } catch { /* skip unreadable */ }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFindings).map(s => s.finding);
}

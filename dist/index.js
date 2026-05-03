#!/usr/bin/env node
/**
 * Qualmly Audit — GitHub Action entrypoint
 *
 * Runs a Qualmly Code Review on the files changed in a pull request and posts
 * findings as a PR comment, line-anchored review, or workflow summary.
 *
 * Compiled bundle target: this file is the runnable entrypoint that GitHub
 * loads (`runs.main`). It uses only Node 20 built-ins so we don't need to
 * pre-bundle dependencies. Pure stdlib + fetch.
 *
 * Architecture:
 *   1. Read inputs from process.env (GitHub Action sets INPUT_<NAME>)
 *   2. Read changed files for this PR via the GitHub REST API
 *   3. Filter: skip files larger than max_kb_per_file, cap at max_files
 *   4. Concatenate file contents with the same filesBlock format Qualmly's
 *      Code Review uses
 *   5. POST to Anthropic /v1/messages with the same prompt template Qualmly
 *      uses (extracted to keep parity)
 *   6. Parse the JSON response (with truncation repair, same as the app)
 *   7. Format findings as Markdown
 *   8. Post to the PR via comment_mode setting
 *   9. Set outputs (score, counts, cost) and exit code per fail_on threshold
 */

'use strict';

const fs = require('fs');

// ── Inputs ──────────────────────────────────────────────────────────────────
const input = (name, fallback) => {
  // GitHub Actions exposes inputs as INPUT_<NAME_UPPERCASE_UNDERSCORE>
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return (v == null || v === '') ? fallback : v;
};
const requireInput = (name) => {
  const v = input(name);
  if (!v) throw new Error(`Missing required input: ${name}`);
  return v;
};

const ANTHROPIC_API_KEY = requireInput('anthropic_api_key');
const GITHUB_TOKEN = requireInput('github_token');
const FAIL_ON = input('fail_on', 'critical').toLowerCase();
const MAX_FILES = parseInt(input('max_files', '12'), 10);
const MAX_KB = parseInt(input('max_kb_per_file', '60'), 10);
const BUILDER = input('builder', 'cursor');
const MODEL = input('model', 'claude-sonnet-4-6');
const COMMENT_MODE = input('comment_mode', 'pr-comment');

// GitHub workflow context (always set on Actions)
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo"
const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;

if (!GITHUB_REPOSITORY || !GITHUB_EVENT_PATH) {
  console.error('::error::This action only runs in a GitHub Actions context (pull_request event).');
  process.exit(1);
}

const eventPayload = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf8'));
const PR_NUMBER = eventPayload.pull_request && eventPayload.pull_request.number;
if (!PR_NUMBER) {
  console.error('::error::No pull_request found in event payload. This action requires `on: pull_request`.');
  process.exit(1);
}

const [OWNER, REPO] = GITHUB_REPOSITORY.split('/');
console.log(`[qualmly-audit] Scanning PR #${PR_NUMBER} on ${OWNER}/${REPO} (builder=${BUILDER}, model=${MODEL})`);

// ── GitHub API helper ──────────────────────────────────────────────────────
async function gh(path, options = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'qualmly-audit-action',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

// ── Fetch changed files in the PR ───────────────────────────────────────────
async function getChangedFiles() {
  const all = [];
  let page = 1;
  while (page < 20) {
    const items = await gh(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files?per_page=100&page=${page}`);
    if (!items.length) break;
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }
  // Filter to interesting source files only
  const SCAN_EXT = /\.(js|jsx|ts|tsx|html|css|py|rb|go|java|rs|sql|sh|yml|yaml|json|md|svelte|vue|astro)$/i;
  const SKIP_PATH = /(^|\/)(node_modules|dist|build|vendor|\.next|\.nuxt|coverage|\.git)\//;
  const filtered = all
    .filter(f => SCAN_EXT.test(f.filename))
    .filter(f => !SKIP_PATH.test('/' + f.filename))
    .filter(f => f.status !== 'removed')
    .filter(f => (f.changes || 0) > 0);
  return filtered.slice(0, MAX_FILES);
}

// ── Fetch file contents from the head ref of the PR ─────────────────────────
async function fetchFileContent(file, ref) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${ref}/${file.filename}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'qualmly-audit-action' }
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_KB * 1024) return { skipped: 'too large' };
  return new TextDecoder().decode(buf);
}

// ── Anthropic prompt (matches Qualmly Code Review prompt; keep in sync) ────
const BUILDER_LABELS = {
  lovable: 'Lovable', bolt: 'Bolt.new', v0: 'v0 by Vercel', cursor: 'Cursor',
  copilot: 'GitHub Copilot', 'claude-code': 'Claude Code', windsurf: 'Windsurf',
  replit: 'Replit', webflow: 'Webflow + AI', other: 'AI coding tool'
};
const BUILDER_CONTEXT = {
  lovable: { surface: 'Lovable web chat', style: 'natural-language prompt' },
  bolt: { surface: 'Bolt.new chat', style: 'natural-language prompt' },
  v0: { surface: 'v0.dev chat', style: 'natural-language prompt' },
  cursor: { surface: 'Cursor inline edit (Cmd+K)', style: 'specific instruction with file/line refs' },
  copilot: { surface: 'GitHub Copilot Chat', style: 'natural-language prompt' },
  'claude-code': { surface: 'Claude Code in your terminal', style: 'natural-language prompt with file paths' },
  windsurf: { surface: 'Windsurf Cascade', style: 'natural-language prompt' },
  replit: { surface: 'Replit AI', style: 'natural-language prompt' },
  webflow: { surface: 'Webflow AI', style: 'natural-language prompt' }
};

function buildPrompt(filesBlock, lang, context) {
  const ctx = BUILDER_CONTEXT[BUILDER] || { surface: 'your AI coding tool', style: 'natural-language prompt' };
  const builderLabel = BUILDER_LABELS[BUILDER] || BUILDER;
  return `You are a senior staff engineer performing a rigorous code review.

Language: ${lang}
What this code does: ${context}
Number of files: ${filesBlock.match(/=== FILE: /g)?.length || 0}
Fix-prompt target: ${builderLabel} (${ctx.surface})

${filesBlock}

Review the code against:
- OWASP Top 10 (2025)
- CWE/SANS Top 25
- WCAG 2.2 (if there is any UI)
- SOLID, DRY, KISS, 12-Factor

Return ONLY valid JSON (no markdown, no extra text), matching exactly:
{
  "score": <integer 0-100; start at 100 and subtract ~12 per fail, ~6 per warn, ~2 per info>,
  "summary": "<2-3 sentence plain-text summary, no HTML tags>",
  "issues": [
    {
      "title": "<short, specific title>",
      "severity": "<fail|warn|info>",
      "category": "<security|accessibility|architecture|performance|correctness>",
      "standard": "<e.g. 'OWASP A03:2021', 'CWE-79', 'WCAG 2.2 1.1.1', 'SOLID: SRP'>",
      "file": "<file name from above, exactly>",
      "line": "<line or range, e.g. '12' or '12-18'>",
      "description": "<1-3 sentence explanation of the problem and impact>",
      "fixConfidence": <integer 0-100>,
      "badCode": "<original snippet, max 6 lines>",
      "goodCode": "<fixed snippet, max 10 lines>",
      "builderFixPrompt": "<2-4 sentence prompt the user pastes into ${ctx.surface}. Style: ${ctx.style}. Reference the file/line/function by name.>"
    }
  ]
}

Requirements:
- Produce 0-12 issues. Focus on changes, not whole-file rewrites.
- Severity \`fail\` = security or correctness bug; \`warn\` = real but recoverable; \`info\` = nit.
- Skip cosmetic/style nits unless they hide a real defect.
- If no real issues found, return an empty issues array and summary explaining why.`;
}

async function callClaude(prompt, signal) {
  const RETRY_STATUSES = new Set([500, 502, 503, 504, 529]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });
    if (res.ok) return res.json();
    if (!RETRY_STATUSES.has(res.status) || attempt === 1) {
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    console.warn(`[qualmly-audit] Anthropic ${res.status} — retrying once after 1.5s`);
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('unreachable');
}

function parseClaudeJson(raw) {
  let clean = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  // Truncation repair: snip to last full issue object
  const lastComma = clean.lastIndexOf('},');
  if (lastComma > 0) {
    clean = clean.slice(0, lastComma + 1) + ']}';
    try { return JSON.parse(clean); } catch (e) {}
  }
  throw new Error('Failed to parse Claude JSON response (after truncation repair).');
}

// ── Cost calculation (matches Qualmly's renderCostFooter) ──────────────────
const PRICING = {
  'claude-sonnet-4-6': { inPerM: 3.0, outPerM: 15.0 },
  'claude-sonnet-4-5': { inPerM: 3.0, outPerM: 15.0 },
  'claude-opus-4-5':   { inPerM: 15.0, outPerM: 75.0 }
};
function calcCost(usage, model) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  return (inT * p.inPerM + outT * p.outPerM) / 1e6;
}

// ── Markdown formatter ─────────────────────────────────────────────────────
function fmtIssue(iss, idx) {
  const sev = (iss.severity || 'info').toLowerCase();
  const icon = sev === 'fail' ? '🔴' : sev === 'warn' ? '🟡' : '🔵';
  const file = iss.file ? `\`${iss.file}\`${iss.line ? `:${iss.line}` : ''}` : '';
  const std = iss.standard ? ` · ${iss.standard}` : '';
  const conf = typeof iss.fixConfidence === 'number' ? ` · fix confidence ${iss.fixConfidence}%` : '';
  return [
    `### ${icon} ${idx + 1}. ${iss.title}`,
    file ? `**${file}**${std}${conf}` : `${std}${conf}`,
    '',
    iss.description || '',
    '',
    iss.badCode ? `<details><summary>Before</summary>\n\n\`\`\`\n${iss.badCode}\n\`\`\`\n</details>` : '',
    iss.goodCode ? `<details><summary>After</summary>\n\n\`\`\`\n${iss.goodCode}\n\`\`\`\n</details>` : '',
    iss.builderFixPrompt ? `**Paste into ${BUILDER_LABELS[BUILDER] || BUILDER}:**\n> ${iss.builderFixPrompt}` : ''
  ].filter(Boolean).join('\n');
}

function fmtComment(report, costUsd, scannedFiles) {
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const nFail = issues.filter(i => (i.severity || '').toLowerCase() === 'fail').length;
  const nWarn = issues.filter(i => (i.severity || '').toLowerCase() === 'warn').length;
  const nInfo = issues.filter(i => (i.severity || '').toLowerCase() === 'info').length;
  const score = typeof report.score === 'number' ? report.score : 0;
  const scoreEmoji = score >= 75 ? '🟢' : score >= 50 ? '🟡' : '🔴';
  return [
    `## ${scoreEmoji} Qualmly Audit — ${score}/100`,
    '',
    `**${nFail}** critical · **${nWarn}** warnings · **${nInfo}** info — across **${scannedFiles}** files.`,
    '',
    report.summary || '',
    '',
    issues.length ? '---\n\n' + issues.map(fmtIssue).join('\n\n---\n\n') : '_No findings._',
    '',
    '---',
    `<sub>Powered by [Qualmly](https://qualmly.dev) · model \`${MODEL}\` · cost ~$${costUsd.toFixed(3)}</sub>`
  ].join('\n');
}

// ── Find existing Qualmly comment to update (avoid spam on rebases) ────────
async function findExistingComment() {
  const comments = await gh(`/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`);
  return comments.find(c => c.body && c.body.startsWith('## ') && c.body.includes('Qualmly Audit'));
}

async function postOrUpdateComment(body) {
  const existing = await findExistingComment();
  if (existing) {
    await gh(`/repos/${OWNER}/${REPO}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body }
    });
    console.log(`[qualmly-audit] Updated existing PR comment ${existing.id}`);
  } else {
    await gh(`/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      body: { body }
    });
    console.log('[qualmly-audit] Posted new PR comment');
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────
function setOutput(name, value) {
  if (GITHUB_OUTPUT) {
    fs.appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(`::set-output name=${name}::${value}`); // legacy; harmless
}

function appendSummary(md) {
  if (GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(GITHUB_STEP_SUMMARY, md + '\n');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const headSha = eventPayload.pull_request.head.sha;
    const headRef = eventPayload.pull_request.head.ref;
    const prTitle = eventPayload.pull_request.title || '';
    const lang = 'mixed';

    const changedFiles = await getChangedFiles();
    if (!changedFiles.length) {
      console.log('[qualmly-audit] No source files changed in this PR. Skipping.');
      setOutput('score', '100');
      setOutput('critical_count', '0');
      setOutput('warn_count', '0');
      setOutput('info_count', '0');
      setOutput('cost_usd', '0');
      appendSummary('## Qualmly Audit\n\n_No source files in this PR changed._');
      return;
    }

    console.log(`[qualmly-audit] Fetching ${changedFiles.length} file(s)`);
    const filesBlock = (await Promise.all(changedFiles.map(async f => {
      const c = await fetchFileContent(f, headSha);
      if (!c) return null;
      if (c.skipped) return `\n\n=== FILE: ${f.filename} ===\n[skipped: ${c.skipped}]`;
      return `\n\n=== FILE: ${f.filename} ===\n${c}`;
    }))).filter(Boolean).join('');

    const prompt = buildPrompt(filesBlock, lang, prTitle || 'pull-request changes');
    const startedAt = Date.now();
    const data = await callClaude(prompt, AbortSignal.timeout(120_000));
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const raw = (data.content || []).map(c => c.text || '').join('');
    const report = parseClaudeJson(raw);

    const costUsd = calcCost(data.usage, MODEL);
    console.log(`[qualmly-audit] Score ${report.score}/100 in ${elapsed}s, ~$${costUsd.toFixed(3)}`);

    const issues = report.issues || [];
    const nFail = issues.filter(i => (i.severity || '').toLowerCase() === 'fail').length;
    const nWarn = issues.filter(i => (i.severity || '').toLowerCase() === 'warn').length;
    const nInfo = issues.filter(i => (i.severity || '').toLowerCase() === 'info').length;

    const md = fmtComment(report, costUsd, changedFiles.length);

    if (COMMENT_MODE === 'pr-comment') {
      await postOrUpdateComment(md);
    } else if (COMMENT_MODE === 'summary') {
      console.log('[qualmly-audit] comment_mode=summary — only writing GITHUB_STEP_SUMMARY');
    } else if (COMMENT_MODE === 'pr-review') {
      // line-anchored review comments; not yet implemented — fall back to consolidated
      console.warn('[qualmly-audit] comment_mode=pr-review not yet implemented; falling back to pr-comment');
      await postOrUpdateComment(md);
    }
    appendSummary(md);

    setOutput('score', String(report.score ?? 0));
    setOutput('critical_count', String(nFail));
    setOutput('warn_count', String(nWarn));
    setOutput('info_count', String(nInfo));
    setOutput('cost_usd', costUsd.toFixed(4));

    // Fail the run per the threshold
    const FAIL_LEVELS = { critical: nFail, warn: nFail + nWarn, info: nFail + nWarn + nInfo, never: 0 };
    const trigger = FAIL_LEVELS[FAIL_ON] ?? FAIL_LEVELS.critical;
    if (trigger > 0 && FAIL_ON !== 'never') {
      console.error(`::error::Qualmly Audit failed: ${trigger} finding(s) at or above '${FAIL_ON}' severity.`);
      process.exit(1);
    }
    console.log('[qualmly-audit] OK');
  } catch (err) {
    console.error('::error::' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();

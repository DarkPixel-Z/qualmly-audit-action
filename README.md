# Qualmly Audit — GitHub Action

Run a Qualmly Code Review on every pull request. Findings post as a PR comment with the same per-issue "Paste this into [your AI builder]" prompt the qualmly.dev app produces.

**Built on:** the same Anthropic Claude prompt qualmly.dev uses, packaged as a Node 20 GitHub Action with no external dependencies.
**Cost:** ~$0.03–$0.20 per PR (your Anthropic key, your bill — see [pricing](#cost)).
**License:** MIT.

---

## Quick start

Add `.github/workflows/qualmly.yml` to any repository:

```yaml
name: Qualmly Audit
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write   # required to post PR comments
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: DarkPixel-Z/qualmly-audit-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          builder: cursor          # or lovable, bolt, v0, copilot, claude-code, windsurf, replit
          fail_on: critical        # critical | warn | info | never
```

Add your Anthropic API key as a repo secret named `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions → New repository secret).

That's it. Open a PR, get a comment.

---

## What it does

1. Reads the files changed in the PR (skips `node_modules`, `dist`, `vendor`, etc.)
2. Sends them to Anthropic Claude with Qualmly's Code Review prompt (OWASP/CWE/WCAG/SOLID/12-Factor)
3. Posts a single consolidated PR comment with findings, before/after diffs, and a "Paste this into [your AI builder]" fix prompt per finding
4. Updates the same comment on every push to the PR (no comment spam)
5. Sets workflow outputs: `score`, `critical_count`, `warn_count`, `info_count`, `cost_usd`

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | yes | – | Your Anthropic API key. Use a repo secret. |
| `github_token` | yes | – | `${{ secrets.GITHUB_TOKEN }}` — needs `pull-requests: write`. |
| `fail_on` | no | `critical` | Severity threshold that fails the run. `critical` / `warn` / `info` / `never`. |
| `max_files` | no | `12` | Max changed files to scan in one run. Larger PRs are truncated. |
| `max_kb_per_file` | no | `60` | Skip files larger than this (KB). |
| `builder` | no | `cursor` | AI builder used to write the code. Drives the per-finding paste prompt. |
| `model` | no | `claude-sonnet-4-6` | Anthropic model. |
| `comment_mode` | no | `pr-comment` | `pr-comment` (single consolidated comment) / `summary` (workflow summary only) / `pr-review` (line-anchored — coming soon). |

## Outputs

| Output | Description |
|---|---|
| `score` | Overall quality score (0–100). |
| `critical_count` | Number of `fail`-severity findings. |
| `warn_count` | Number of `warn`-severity findings. |
| `info_count` | Number of `info`-severity findings. |
| `cost_usd` | Estimated Anthropic API spend for this run. |

You can use these to drive downstream steps:

```yaml
- uses: DarkPixel-Z/qualmly-audit-action@v1
  id: qualmly
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Block merge on low score
  if: steps.qualmly.outputs.score < 60
  run: exit 1
```

## Cost

The action uses your own Anthropic API key. Typical per-PR cost:

| PR size | Tokens (approx.) | Cost (claude-sonnet-4-6) |
|---|---|---|
| 1–3 small files | ~5K in / 2K out | ~$0.05 |
| 5–8 medium files | ~15K in / 4K out | ~$0.11 |
| 12 large files (max) | ~50K in / 6K out | ~$0.24 |

The `cost_usd` output prints actual cost per run. Anthropic billing dashboard shows the totals across PRs.

## Why an action that uses your own key?

Most code-review SaaS (CodeRabbit, Snyk, Qodo) are $15–$30 per user per month. Qualmly's GitHub Action is open source — you bring your own Anthropic key, so the entire "code review SaaS" cost line on your engineering team becomes the variable cost of the API calls themselves. For most teams that's ~$10–$50/month total instead of $15+/month *per user*.

If your team has an Anthropic account already (because you're using Claude Code / Cursor with Claude / etc.), the marginal cost of adding PR review is essentially zero per PR.

## What it doesn't do (yet)

- Line-anchored review comments (`comment_mode: pr-review`) — coming in v1.1
- Multi-file holistic review (currently sees changed files but does not load context from un-changed files in the same PR) — coming in v2
- Custom prompt templates — coming in v1.1

## License

MIT — same as the parent project at https://github.com/DarkPixel-Z/qualmly.

## Support

- Issues: https://github.com/DarkPixel-Z/qualmly-audit-action/issues
- Email: info@darkpixelconsultinginc.co
- Tool: https://qualmly.dev

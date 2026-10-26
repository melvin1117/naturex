# AI tooling setup

How each team member connects their AI assistant to the shared skills and MCP servers. Rules for the assistants themselves are in [AGENTS.md](../AGENTS.md).

## Prerequisites
- **Node.js 22+** (all MCP servers run through `npx`; `impeccable` scripts need it too)
- **git**

## What's in the repo
| Path | Purpose | Read by |
|---|---|---|
| `AGENTS.md` | Shared instructions | Copilot, Cursor, Codex; Claude via `CLAUDE.md` (`@AGENTS.md`) |
| `.agents/skills/` | 31 skills (see [.agents/SOURCES.md](../.agents/SOURCES.md)) | Copilot, Cursor, Codex |
| `.claude/skills/` | Symlinks to the same skills (+ impeccable's Claude build) | Claude Code |
| `.vscode/mcp.json` | MCP servers | GitHub Copilot in VS Code |
| `.cursor/mcp.json` | MCP servers | Cursor |
| `.mcp.json` | MCP servers (project scope) | Claude Code |
| `.codex/config.toml` | MCP servers (project scope, trusted projects only) | Codex |
| `scripts/sync-skills.sh` | Reinstalls skills from pinned commits | Everyone |

**Windows:** enable symlinks before cloning (`git config --global core.symlinks true` plus Developer Mode), or `.claude/skills` won't work.

## Per-tool setup
### GitHub Copilot (VS Code)
1. Open the repo folder and trust it.
2. Open `.vscode/mcp.json` and click **Start** on each server. GitHub signs in with OAuth; no token needed.
3. Skills and `AGENTS.md` load automatically in agent mode.

### Cursor
1. Create a GitHub personal access token (fine-grained, this repo only: Issues, Pull requests, Contents read) and export it: `export GITHUB_PERSONAL_ACCESS_TOKEN=...` (e.g. in your shell profile).
2. Enable the servers under **Settings → MCP**.

### Claude Code
1. Export `GITHUB_PERSONAL_ACCESS_TOKEN` as above.
2. Start `claude` in the repo and approve the project MCP servers when prompted (`/mcp` shows status).

### Codex
1. Export `GITHUB_PERSONAL_ACCESS_TOKEN` as above.
2. Run `codex` in the repo and **trust the project** when asked; Codex then loads the project config in `.codex/config.toml` (MCP servers). Check with `/mcp`.

### GitHub Copilot CLI and Copilot cloud agent
- Both read `AGENTS.md` and the skills in `.agents/skills/` automatically.
- **Copilot CLI:** add the MCP servers to your user config (`~/.copilot/mcp-config.json`) or with `/mcp add`.
- **Copilot cloud agent** (assigning issues to Copilot on github.com): add MCP servers in the repo's **Settings → Copilot → Coding agent**.

### Known quirk
VS Code scans both `.agents/skills` and `.claude/skills`, so older VS Code versions may **list each skill twice**. It's harmless; update VS Code to get the fix (reported fixed from 1.125).

## Independent review before every PR
The *Independent review* step in [AGENTS.md](../AGENTS.md): before opening a PR, a **separate agent with fresh context** (not the one that wrote the code) reviews the diff with the `code-review-and-quality` skill. A reviewer without the author's reasoning catches what the author can't see. On T31 (#84) it found that "Reset my demo" deleted the LLM call log, which would let spend escape `LLM_BUDGET_USD`, while all 138 tests passed.

How to start one (commit your work and run `git fetch origin` first):
| Tool | Fresh-context reviewer |
|---|---|
| GitHub Copilot CLI | Ask it to run the prompt below in a **general-purpose sub-agent** (the `task` tool). The built-in `code-review` agent only reports bugs, so it drops readability and architecture findings |
| GitHub Copilot in VS Code | Turn on **Run Subagent** (`runSubagent`) under *Configure Tools*, then write "Use a subagent to…" followed by the prompt below |
| Claude Code | Ask it to use a **subagent** with the prompt below |
| Cursor / Codex | Open a **new chat or session** on the same branch and paste the prompt. Codex's built-in `/review` can run as well, but doesn't replace it |

Prompt to paste (fill in the task; don't add your own explanation of the design):
```text
Use the code-review-and-quality skill to review ONLY the changes in `git diff origin/main...HEAD`
for task T<NN> (issue #<n>). Don't review the rest of the codebase; read surrounding code only
where you need it to judge a changed line. Acceptance criteria: <copy from tasks/todo.md and the
story in docs/specs/pm-spec.md>. Relevant specs: <dev-spec §…>. If the diff touches auth,
cookies, sessions, request input or text passed into an LLM prompt, also use the
security-and-hardening skill.
Review correctness, readability, architecture, security and performance of the changes; run
only the tests that cover them. Don't change, commit or push anything.
Label every finding Critical / Required / Consider / Nit / FYI with file:line, a concrete
failure scenario and a fix, and list missing tests. Be concise: no praise, no restating the diff.
```
Then **show the findings to the user, who decides** which to fix and which to reject (with a reason). Apply only the agreed fixes, don't commit or push them without the user's go-ahead, re-run `make ci`, and summarise the review in the PR's "Independent review" section (write "None" if there were no Critical or Required findings). A teammate still approves the PR; the agent review doesn't replace that.

## Optional: Context7 API key
Context7 works without a key but is rate-limited. For higher limits, get a free key at context7.com/dashboard and add `"--api-key", "<key>"` to the Context7 `args` **in your personal (user-level) config only**. Never commit it.

## Launch teaser: brag-slim (in the repo)
`brag-slim` ([latent-spaces/brag](https://github.com/latent-spaces/brag), MIT) is vendored in `.agents/skills/` like the other skills. Ask for "/brag-slim" or "make a launch video" to get a 15–25 s teaser built from the codebase.
- Needs Node 22+ and FFmpeg. If FFmpeg isn't on `PATH`, install `ffmpeg-static` inside `brag-output/work/` rather than globally.
- It has no bundled assets: the model writes the visuals and **synthesises its own soundtrack**, so there's no third-party music to clear. Still check the result against the hackathon video rules (no third-party logos, play-money framing on screen).
- Numbers on screen must come from the engine (for example `frontend/src/lib/sites.json`), never invented.
- It's a teaser only; **it doesn't replace the 3-minute demo video**, which must show the real app running (see [specs/demo-plan.md](./specs/demo-plan.md)).
- Output goes to `brag-output/` (git-ignored).

## Optional personal skills (not in the repo)
Install these in your **user** folder (`-g`) only if you need them, so they never end up in the repo.

| Skill | What it's for | Install |
|---|---|---|
| [brag](https://github.com/latent-spaces/brag) (MIT) | The full version of brag-slim: bundled music and the Hyperframes CLI | `npx skills add https://github.com/latent-spaces/brag --skill brag -g` |

**Using the full brag:**
- Needs Node 22+, **FFmpeg** on `PATH` and the Hyperframes CLI (`npx hyperframes doctor`).
- Run `/brag --no-music` unless we have clear rights to a track. The hackathon video rules forbid unlicensed music, and brag's bundled tracks have unverified licences.

## Updating skills
Edit the pinned commit in `scripts/sync-skills.sh`, run it, review the diff, and update `.agents/SOURCES.md`.

# AI tooling setup

How each team member connects their AI assistant to the shared skills and MCP servers. Rules for the assistants themselves are in [AGENTS.md](../AGENTS.md).

## Prerequisites
- **Node.js 22+** (all MCP servers run through `npx`; `impeccable` scripts need it too)
- **git**

## What's in the repo
| Path | Purpose | Read by |
|---|---|---|
| `AGENTS.md` | Shared instructions | Copilot, Cursor, Codex; Claude via `CLAUDE.md` (`@AGENTS.md`) |
| `.agents/skills/` | 30 skills (see [.agents/SOURCES.md](../.agents/SOURCES.md)) | Copilot, Cursor, Codex |
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

## Optional: Context7 API key
Context7 works without a key but is rate-limited. For higher limits, get a free key at context7.com/dashboard and add `"--api-key", "<key>"` to the Context7 `args` **in your personal (user-level) config only**. Never commit it.

## Optional personal skills (not in the repo)
Install these in your **user** folder (`-g`) only if you need them, so they never end up in the repo.

| Skill | What it's for | Install |
|---|---|---|
| [brag](https://github.com/latent-spaces/brag) (MIT) | A 15–25 s launch-style teaser video made from the codebase | `npx skills add https://github.com/latent-spaces/brag --skill brag -g` |

**Using brag:**
- Needs Node 22+, **FFmpeg** on `PATH` and the Hyperframes CLI (`npx hyperframes doctor`).
- Run `/brag --no-music` unless we have clear rights to a track. The hackathon video rules forbid unlicensed music, and brag's bundled tracks have unverified licences.
- It's a teaser only; **it doesn't replace the 3-minute demo video**, which must show the real app running (see [specs/demo-plan.md](./specs/demo-plan.md)).
- Output goes to `brag-output/` (git-ignored).

## Updating skills
Edit the pinned commit in `scripts/sync-skills.sh`, run it, review the diff, and update `.agents/SOURCES.md`.

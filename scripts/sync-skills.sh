#!/usr/bin/env bash
# Installs the team's AI agent skills from pinned upstream commits.
#
#   .agents/skills/  -> read by GitHub Copilot, Cursor and Codex
#   .claude/skills/  -> read by Claude Code (symlinks, except impeccable's Claude build)
#
# Usage: scripts/sync-skills.sh          # install or refresh at the pinned commits
# To upgrade a source, change its commit below, re-run, review the diff and update .agents/SOURCES.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$ROOT/.agents"
SKILLS="$AGENTS_DIR/skills"
CLAUDE_SKILLS="$ROOT/.claude/skills"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ADDY_SHA=2686b620fc1fed2e8f60c704839c766b8594c6b6
IMPECCABLE_SHA=9d715cc4f5564a990ca8345abfdd5df6dc9b41c8
VERCEL_SHA=063bee94c3f4df8453406c830b0a7df0f2860278
SUPABASE_SHA=551274ed2fe97c8fea1325f7ceb05803a542f8df

fetch() { # fetch <owner/repo> <sha> <dir>
  git init -q "$3"
  git -C "$3" remote add origin "https://github.com/$1.git"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
}

copy_skill() { # copy_skill <src-dir> <dest-name>
  rm -rf "${SKILLS:?}/$2"
  cp -R "$1" "$SKILLS/$2"
}

echo "Fetching sources..."
fetch addyosmani/agent-skills "$ADDY_SHA" "$TMP/addy"
fetch pbakaus/impeccable "$IMPECCABLE_SHA" "$TMP/impeccable"
fetch vercel-labs/agent-skills "$VERCEL_SHA" "$TMP/vercel"
fetch supabase/agent-skills "$SUPABASE_SHA" "$TMP/supabase"

mkdir -p "$SKILLS" "$AGENTS_DIR/licenses" "$CLAUDE_SKILLS"

# addyosmani/agent-skills: all skills + shared checklists (skills link to ../../references/)
for d in "$TMP"/addy/skills/*/; do copy_skill "$d" "$(basename "$d")"; done
rm -rf "$AGENTS_DIR/references" && cp -R "$TMP/addy/references" "$AGENTS_DIR/references"
cp "$TMP/addy/LICENSE" "$AGENTS_DIR/licenses/addyosmani-agent-skills.LICENSE"

# pbakaus/impeccable: prebuilt harness-specific skill (shared build + Claude build)
copy_skill "$TMP/impeccable/.agents/skills/impeccable" impeccable
cp "$TMP/impeccable/LICENSE" "$AGENTS_DIR/licenses/impeccable.LICENSE"
cp "$TMP/impeccable/NOTICE.md" "$AGENTS_DIR/licenses/impeccable.NOTICE.md"

# vercel-labs/agent-skills: UI review + React/Next.js performance (MIT per README and skill metadata)
copy_skill "$TMP/vercel/skills/web-design-guidelines" web-design-guidelines
copy_skill "$TMP/vercel/skills/react-best-practices" vercel-react-best-practices
# Rename the skill's full guide so AI tools don't treat a nested AGENTS.md as repo instructions
mv "$SKILLS/vercel-react-best-practices/AGENTS.md" "$SKILLS/vercel-react-best-practices/GUIDE.md"
sed -i.bak 's/`AGENTS.md`/`GUIDE.md`/' "$SKILLS/vercel-react-best-practices/SKILL.md"
rm "$SKILLS/vercel-react-best-practices/SKILL.md.bak"

# supabase/agent-skills: Supabase + Postgres best practices
copy_skill "$TMP/supabase/skills/supabase" supabase
copy_skill "$TMP/supabase/skills/supabase-postgres-best-practices" supabase-postgres-best-practices
cp "$TMP/supabase/LICENSE" "$AGENTS_DIR/licenses/supabase-agent-skills.LICENSE"

# Drop packaging files no skill uses
rm -f "$SKILLS"/vercel-react-best-practices/{README.md,metadata.json} "$SKILLS"/supabase*/CHANGELOG.md

# Personal, optional skills (e.g. brag) are NOT vendored; see docs/ai-setup.md.

# Claude Code: mirror every shared skill via symlink, but use impeccable's Claude-specific build
find "$CLAUDE_SKILLS" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
for d in "$SKILLS"/*/; do
  name="$(basename "$d")"
  [ "$name" = impeccable ] && continue
  ln -s "../../.agents/skills/$name" "$CLAUDE_SKILLS/$name"
done
cp -R "$TMP/impeccable/.claude/skills/impeccable" "$CLAUDE_SKILLS/impeccable"
# Claude's build differs only in command syntax; share the identical 2 MB scripts folder
rm -rf "$CLAUDE_SKILLS/impeccable/scripts"
ln -s ../../../.agents/skills/impeccable/scripts "$CLAUDE_SKILLS/impeccable/scripts"
rm -rf "$ROOT/.claude/references" && ln -s ../.agents/references "$ROOT/.claude/references"

echo "Installed $(find "$SKILLS" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') skills into .agents/skills (mirrored in .claude/skills)."

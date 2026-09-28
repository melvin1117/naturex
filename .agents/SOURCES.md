# Third-party agent skills

Installed by [`scripts/sync-skills.sh`](../scripts/sync-skills.sh) from pinned upstream commits. **Don't edit skill files by hand**: change the pin in the script, re-run it, and review the diff. Licence texts are in [`licenses/`](./licenses/).

| Source | Commit | Licence | Installed as | Used for |
|---|---|---|---|---|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `2686b62` | MIT | 25 skills + `references/` checklists | Core engineering workflow: spec, plan, build, test, review, security, git, ADRs, CI |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `9d715cc` | Apache-2.0 (see `licenses/impeccable.NOTICE.md`) | `impeccable` (shared build; Claude build in `.claude/skills/impeccable`) | Distinctive, non-generic UI/UX design, critique and polish |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `063bee9` | MIT (README + skill metadata; no LICENSE file upstream) | `web-design-guidelines`, `vercel-react-best-practices` | UI accessibility/UX audit; React and Next.js performance |
| [supabase/agent-skills](https://github.com/supabase/agent-skills) | `551274e` | MIT | `supabase`, `supabase-postgres-best-practices` | Schema design, migrations, pgvector, Postgres performance |

## Local modifications
- **vercel-react-best-practices:** folder renamed from `react-best-practices` so it matches the skill's `name`. Its full guide `AGENTS.md` is renamed to `GUIDE.md` (and the one reference in `SKILL.md` updated), so AI tools don't mistake it for repo instructions.
- **Unused packaging files removed:** Vercel's `README.md` and `metadata.json`, and Supabase's `CHANGELOG.md` files.
- **impeccable (Claude):** `.claude/skills/impeccable/scripts` is a symlink to the shared build's identical `scripts/` folder (the two builds differ only in `/` vs `$` command syntax), saving ~2 MB.
- No other changes.

Optional personal skills such as `brag` are installed per person, not in the repo; see [ai-setup.md](../docs/ai-setup.md).

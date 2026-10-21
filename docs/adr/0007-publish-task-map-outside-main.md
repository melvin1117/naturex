# ADR-0007: Publish the task map outside `main`

## Status
Proposed (2026-10-21). Fixes [#187](https://github.com/melvin1117/naturex/issues/187).

## Date
2026-10-21

## Context
- The task map (`task-map.html` for people, `task-map.json` for agents) is generated from GitHub issues by `scripts/task_map.py`. The `task-map` workflow used to commit it to `main` with the workflow's `GITHUB_TOKEN`.
- Once the repo went public, the `protect-main` ruleset became enforced: changes to `main` need a PR with 13 passing required checks, linear history and no force-pushes. The workflow's direct push is rejected (GH013), so the checked-in map went stale while the board stayed current.
- A ruleset bypass for the GitHub Actions integration was rejected by the API (HTTP 422: the actor must belong to the ruleset's source or owner organization), and broad administrator or user bypasses would weaken the protection of `main` for everyone.
- Generated files on `main` also caused merge conflicts, which is why feature PRs must never touch them.

## Decision
- **The map lives on the orphan branch `task-map`, never on `main`.** The branch holds only generated files (`task-map.html`, `task-map.json`, an `index.html` redirect and `.nojekyll`). The ruleset targets only the default branch, so no bypass and no settings change are needed.
- **Each publish is one fresh, parentless commit, force-pushed** by `scripts/task_map_publish.sh` with `--force-with-lease` on the commit the run read, so the branch has no history to grow and a concurrent change makes the push fail instead of being overwritten. The script checks with `git ls-remote` whether the branch exists: only a missing branch starts a new one; a branch that exists but can't be fetched fails the run.
- **Publish only on change.** The JSON's `data_hash` covers the issue data and the git blob hash of `scripts/task_map.py`, so an unchanged map isn't republished, and a template change always is, even if the run triggered by its merge was replaced in the concurrency queue.
- **Least privilege.** Only the `publish` job has `contents: write` (plus `issues: read`); the workflow default is no permissions. Checkout runs with `persist-credentials: false`. The token is passed to the publish step only; the script turns it into an HTTP header in its own process environment and masks the encoded value in the logs, so it never reaches `.git/config`, `$GITHUB_ENV` or a command line. The job runs code from `main` only and doesn't read issue text. A `concurrency` group serialises publishes.
- **`main` stops tracking `tasks/task-map.*`.** They're git-ignored, so `make task-map` (local regeneration) and `make task-map-latest` (download of the published map) write local copies that can't be committed by accident.
- **Validation before merge.** `scripts/task_map.py --check` parses `tasks/todo.md` offline. It fails on task headings that don't parse, duplicate IDs and unknown dependencies. `make ci` runs it, and the workflow's `check` job runs it on every PR (the owner may make `task-map / check` a required check). Tests cover the generator and, against a local bare remote, the publish script's lease and change detection.
- **Optional web page.** The repo owner can serve the branch with GitHub Pages (*Deploy from a branch* → `task-map` / root); the workflow doesn't need to change.

## Alternatives considered
| Option | Why not |
|---|---|
| Ruleset bypass for GitHub Actions | Rejected by the API (422). Any bypass that works would let every workflow push to `main` unreviewed. |
| Administrator or user bypass with a personal access token | Ties automation to one person's account and lets that token skip every check on `main`. |
| Bot PR per map change (auto-merge) | PRs opened with `GITHUB_TOKEN` don't trigger workflows, so the 13 required checks never run and the PR never merges. Working around that needs a PAT or an App; and frequent bot PRs add noise and conflicts. |
| A GitHub App with a bypass or its own PRs | Works, but needs an App, a private key stored as a secret and its rotation for a status page. Too much surface for a hackathon. |
| Workflow artifact or GitHub Pages only | Artifacts expire and need the API or a login to read; Pages alone needs a settings change before anything works. The branch works at once; Pages stays an option on top of it. |
| Stop generating the map (board only) | The JSON's `suggestions`, `waiting_on` and `unlocks` are what agents use to pick tasks; the board can't express dependencies. |

## Consequences
- People and agents read the map from the `task-map` branch (`make task-map-latest`, `git show origin/task-map:task-map.json` or the raw URL) instead of `git pull`.
- `tasks/todo.md` and `tasks/plan.md` link to the branch instead of a file next to them.
- The `task-map` branch must stay unprotected and must not be edited by hand: the next publish replaces it.
- If the repo goes private again, the raw URL needs auth; `make task-map-latest` keeps working with the usual git credentials.

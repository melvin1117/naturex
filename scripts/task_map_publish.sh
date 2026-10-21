#!/usr/bin/env bash
# Publish the task map to the orphan branch `task-map` (ADR-0007). Used by the task-map workflow.
#
#   scripts/task_map_publish.sh <remote-url> <work-dir> [task_map.py args...]
#
# Reads the published map from <remote-url> into <work-dir>, regenerates it there with
# scripts/task_map.py, and, only if it changed, force-pushes a single parentless commit with a
# lease on the commit it read (so a concurrent change fails the push instead of being lost).
#
# TASK_MAP_TOKEN (optional): a token for github.com. It reaches git only as an HTTP header in this
# process's environment (never .git/config, a command line or $GITHUB_ENV), and the derived value
# is masked in GitHub Actions logs.
set -euo pipefail

BRANCH=task-map
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  echo "task-map: $*" >&2
  exit 1
}

setup_auth() {
  [ -n "${TASK_MAP_TOKEN:-}" ] || return 0
  local basic n="${GIT_CONFIG_COUNT:-0}"
  basic="$(printf 'x-access-token:%s' "$TASK_MAP_TOKEN" | base64 | tr -d '\n')"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::$basic"
  fi
  export "GIT_CONFIG_KEY_$n=http.https://github.com/.extraheader"
  export "GIT_CONFIG_VALUE_$n=AUTHORIZATION: basic $basic"
  export GIT_CONFIG_COUNT=$((n + 1))
}

# Prints the published commit (empty if the branch doesn't exist yet) and checks it out in <dir>.
fetch_map() {
  local remote="$1" dir="$2" rc=0
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git ls-remote --exit-code --heads "$remote" "$BRANCH" >/dev/null || rc=$?
  case "$rc" in
    0) ;;
    2)
      echo "No $BRANCH branch yet; this run creates it." >&2
      return 0
      ;;
    *) die "couldn't list branches on the remote (git ls-remote exit $rc)" ;;
  esac
  git -C "$dir" fetch --quiet --depth=1 "$remote" "+refs/heads/$BRANCH:refs/remotes/published/$BRANCH" \
    || die "the $BRANCH branch exists but couldn't be fetched"
  git -C "$dir" checkout --quiet --detach "refs/remotes/published/$BRANCH" \
    || die "couldn't check out the published map"
  git -C "$dir" rev-parse "refs/remotes/published/$BRANCH"
}

# Exits 0 if the generated files differ from the published commit (or nothing is published yet).
map_changed() {
  local dir="$1" lease="$2"
  [ -z "$lease" ] && return 0
  [ -n "$(git -C "$dir" status --porcelain -- task-map.html task-map.json)" ]
}

# Pushes the files in <dir> as one parentless commit, expecting the branch to be at <lease>
# (empty: expecting no branch).
push_map() {
  local remote="$1" dir="$2" lease="$3" src tree commit
  src="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf '<!doctype html><meta charset="utf-8"><title>NatureX task map</title><meta http-equiv="refresh" content="0; url=task-map.html"><a href="task-map.html">NatureX task map</a>\n' \
    >"$dir/index.html"
  : >"$dir/.nojekyll"
  git -C "$dir" add -- task-map.html task-map.json index.html .nojekyll
  tree="$(git -C "$dir" write-tree)"
  commit="$(
    GIT_AUTHOR_NAME="github-actions[bot]" \
      GIT_AUTHOR_EMAIL="41898900+github-actions[bot]@users.noreply.github.com" \
      GIT_COMMITTER_NAME="github-actions[bot]" \
      GIT_COMMITTER_EMAIL="41898900+github-actions[bot]@users.noreply.github.com" \
      git -C "$dir" commit-tree --no-gpg-sign -m "chore(tasks): publish task map from $src" "$tree"
  )"
  git -C "$dir" push --quiet --force-with-lease="refs/heads/$BRANCH:$lease" "$remote" "$commit:refs/heads/$BRANCH" \
    || die "push rejected: the $BRANCH branch changed since it was read (or the token can't write)"
  echo "Published ${commit:0:7} to the $BRANCH branch."
}

main() {
  [ "$#" -ge 2 ] || die "usage: $0 <remote-url> <work-dir> [task_map.py args...]"
  local remote="$1" dir="$2" lease
  shift 2
  setup_auth
  lease="$(fetch_map "$remote" "$dir")"
  python3 "$ROOT/scripts/task_map.py" --out-dir "$dir" "$@"
  if ! map_changed "$dir" "$lease"; then
    echo "No change."
    return 0
  fi
  push_map "$remote" "$dir" "$lease"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

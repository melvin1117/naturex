#!/usr/bin/env bash
# Set a task's Status on the WildWorth Project board and keep the assignee in sync.
#   scripts/board_status.sh <issue-number> "<Todo|In progress|In review|Done>"
# Needs: gh auth login -s project   (the board is a user-level GitHub Project)
set -euo pipefail

OWNER=melvin1117
REPO=melvin1117/naturex
PROJECT=2

issue=${1:?usage: board_status.sh <issue> <status>}
status=${2:?usage: board_status.sh <issue> <status>}

project_id=$(gh project view "$PROJECT" --owner "$OWNER" --format json --jq .id)
field_id=$(gh project field-list "$PROJECT" --owner "$OWNER" --format json \
  --jq '.fields[] | select(.name == "Status") | .id')
option_id=$(gh project field-list "$PROJECT" --owner "$OWNER" --format json \
  --jq ".fields[] | select(.name == \"Status\") | .options[] | select(.name == \"$status\") | .id")
[ -n "$option_id" ] || { echo "Unknown status: $status" >&2; exit 1; }

item_id=$(gh project item-list "$PROJECT" --owner "$OWNER" --limit 500 --format json \
  --jq ".items[] | select(.content.number == $issue and .content.repository == \"$REPO\") | .id")
if [ -z "$item_id" ]; then
  item_id=$(gh project item-add "$PROJECT" --owner "$OWNER" \
    --url "https://github.com/$REPO/issues/$issue" --format json --jq .id)
fi

gh project item-edit --id "$item_id" --project-id "$project_id" \
  --field-id "$field_id" --single-select-option-id "$option_id" >/dev/null

if [ "$status" = "In progress" ]; then
  gh issue edit "$issue" -R "$REPO" --add-assignee @me >/dev/null
fi
echo "#$issue → $status"

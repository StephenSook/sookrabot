#!/usr/bin/env bash
# Run a self-play comparison on GitHub Actions and print its result.
#
#   bash bot-starter/scripts/selfplay_remote.sh [--ref BRANCH] [--out DIR] FIELDS MATCHES SEED SHARDS VARIANT...
#
#   FIELDS    one field, or several in one quoted argument ("ar6-top ar6-v4 duel-james-v4")
#   VARIANT   head, or strategy.ts constants NAME=value joined by +; the first is the baseline
#
# Dispatches .github/workflows/selfplay.yml on BRANCH (default harness-sync), takes the run
# id from the dispatch's own output (so runs dispatched together never get mixed up), waits
# for the run, judges it by the API (the run's conclusion and the aggregate job's, not by the
# watcher's exit status), downloads every artifact to DIR/<run id> (default
# ./selfplay-runs), re-checks the shard rows with selfplay_aggregate.py, and prints the
# result table. Exit 0 only when the run succeeded and the local check agrees.
set -euo pipefail

repo=StephenSook/sookrabot
ref=harness-sync
out=selfplay-runs
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --ref) ref=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [[ $# -lt 5 ]]; then
  echo "usage: $0 [--ref BRANCH] [--out DIR] FIELDS MATCHES SEED SHARDS VARIANT..." >&2
  exit 2
fi
fields=$1 matches=$2 seed=$3 shards=$4
shift 4
variants="$*"
here=$(cd "$(dirname "$0")" && pwd)

dispatch=$(gh workflow run selfplay.yml --repo "$repo" --ref "$ref" \
  -f field="$fields" -f matches="$matches" -f seed="$seed" -f variants="$variants" -f shards="$shards" 2>&1) || {
  echo "dispatch failed:" >&2
  echo "$dispatch" >&2
  exit 1
}
if [[ ! "$dispatch" =~ actions/runs/([0-9]+) ]]; then
  echo "dispatch gave no run id:" >&2
  echo "$dispatch" >&2
  exit 1
fi
id=${BASH_REMATCH[1]}
echo "run $id: https://github.com/$repo/actions/runs/$id"

# gh run watch can stop early on a network error; re-watch a bounded number of times.
status=""
for attempt in 1 2 3 4; do
  gh run watch "$id" --repo "$repo" --interval 15 > /dev/null 2>&1 || true
  status=$(gh run view "$id" --repo "$repo" --json status --jq .status)
  [[ "$status" == "completed" ]] && break
done
[[ "$status" == "completed" ]] || { echo "run $id still $status after 4 watches" >&2; exit 1; }
conclusion=$(gh run view "$id" --repo "$repo" --json conclusion --jq .conclusion)
aggregate=$(gh api --paginate "repos/$repo/actions/runs/$id/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "aggregate") | .conclusion')
if [[ "$conclusion" != "success" || "$aggregate" != "success" ]]; then
  echo "run $id: conclusion $conclusion, aggregate job ${aggregate:-missing}" >&2
  gh api --paginate "repos/$repo/actions/runs/$id/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion != "success") | "  \(.name): \(.conclusion)"' >&2
  exit 1
fi

dir="$out/$id"
mkdir -p "$dir"
gh run download "$id" --repo "$repo" --dir "$dir"
shopt -s nullglob
shard_dirs=("$dir"/rows-"$id"-*)
(( ${#shard_dirs[@]} > 0 )) || { echo "run $id: no rows artifacts downloaded" >&2; exit 1; }
# The rows themselves must be complete and consistent (exit 1 otherwise); a text difference
# from the run's own table can only come from a different version of the aggregator script.
python3 -I "$here/selfplay_aggregate.py" "${shard_dirs[@]}" --expect="$matches" > "$dir/local-check.txt"
if ! cmp -s "$dir/local-check.txt" "$dir/result-$id/result.txt"; then
  echo "note: this checkout's selfplay_aggregate.py prints the rows differently from the run's copy; both tables follow" >&2
  cat "$dir/local-check.txt"
fi
cat "$dir/result-$id/result.txt"
echo "(rows and results in $dir)"

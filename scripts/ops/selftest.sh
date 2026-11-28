#!/usr/bin/env bash
# selftest.sh: runs the self-tests of the ops scripts, one after the other.
#
#   ./scripts/ops/selftest.sh              # all six
#   ./scripts/ops/selftest.sh --light      # the four that need only bash and git
#   ./scripts/ops/selftest.sh lib deploy   # the named ones (lib deploy logs migrate-from-fork cleanup backup-restore)
#
# This is the one command for a developer machine, and what the `ops-selftests`
# job of ci.yml runs on every change under scripts/** (GitHub Actions may be
# switched off in a fork, so the checks must not exist only there).
#
#   lib, deploy, logs,     bash and git only                       ~15 s together
#   migrate-from-fork
#   cleanup                docker, a privileged docker:27-dind     ~45 s
#   backup-restore         docker, free iceslab-prod-* names       ~1 min
#
# Every test runs to its end even when an earlier one failed, so one run shows
# all of the red; the exit code is 1 if any was. Each test is a file of its own
# and can be run alone; the header of each says what it needs.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL=(lib deploy logs migrate-from-fork cleanup backup-restore)

names=()
for arg in "$@"; do
    case "$arg" in
        --light) names+=(lib deploy logs migrate-from-fork) ;;
        -h|--help) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 0 ;;
        lib|deploy|logs|migrate-from-fork|cleanup|backup-restore) names+=("$arg") ;;
        *) echo "selftest.sh: unknown argument: $arg" >&2; exit 2 ;;
    esac
done
[[ ${#names[@]} -gt 0 ]] || names=("${ALL[@]}")

failed=()
summary=""
for n in "${names[@]}"; do
    printf '\n===== %s-selftest.sh =====\n' "$n"
    start=$SECONDS
    if bash "${DIR}/${n}-selftest.sh"; then result=ok; else result=FAILED; failed+=("$n"); fi
    summary+="$(printf '  %-16s %-7s %ss' "$n" "$result" "$((SECONDS - start))")"$'\n'
done

printf '\n===== summary =====\n%s' "$summary"
if [[ ${#failed[@]} -gt 0 ]]; then
    printf 'failed: %s\n' "${failed[*]}"
    exit 1
fi

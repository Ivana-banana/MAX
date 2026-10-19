#!/usr/bin/env bash
# Общее для хуков. hook_log <хук> <причина> — строка в журнал отказов
# <git-common-dir>/hook-refusals.log (один на машину, общий для всех worktree, вне git).
# Журнал читает /retro: какие правила срабатывали и сколько раз.
hook_log() {
  local d
  d="$(git rev-parse --git-common-dir 2>/dev/null)" || return 0
  printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" \
    "$(git branch --show-current 2>/dev/null)" "$(printf '%s' "$2" | tr '\n\t' '  ' | cut -c1-300)" \
    >> "$d/hook-refusals.log" 2>/dev/null || true
}

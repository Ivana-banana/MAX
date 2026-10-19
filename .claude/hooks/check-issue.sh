#!/usr/bin/env bash
# PreToolUse: без взятой задачи не работаем. Правка файла (Edit, Write, MultiEdit,
# NotebookEdit) и git commit / git push через Bash разрешены только в worktree задачи:
# ветка worktree-<N>-<тема>, задача #N открыта и назначена на меня.
# Проверку делает `scripts/issues.sh check`. Не проверяются: файлы вне репозитория,
# scratchpad агента, удаление ветки через push (уборка).
# Отказ — код 2, причина уходит агенту в stderr. Нет jq — пропуск.
set -uo pipefail

input="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0
tool="$(printf '%s' "$input" | jq -r '.tool_name // ""')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // "."')"

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    target="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
    target="${target//\\//}" # Windows: C:\a\b -> C:/a/b
    case "$target" in /*|[A-Za-z]:/*) ;; ?*) target="$cwd/$target" ;; esac
    ;;
  Bash)
    # Тело heredoc — данные, а не команда: смотрим строки до первой строки с «<<».
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' | awk '{print} /<</{exit}' | tr -d "\"'")"
    printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|push)([[:space:]]|$)' || exit 0
    if printf '%s' "$cmd" | grep -Eq 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push[[:space:]].*(--delete|[[:space:]]-d[[:space:]]|[[:space:]]:[^[:space:]]+)'; then
      exit 0
    fi
    target="$(printf '%s' "$cmd" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+)[[:space:]]+(commit|push).*/\1/p' | head -1)"
    [ -n "$target" ] || target="$(printf '%s' "$cmd" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^[:space:];&]+).*/\1/p' | head -1)"
    [ -n "$target" ] || target="$cwd"
    case "$target" in /*|[A-Za-z]:/*) ;; *) target="$cwd/$target" ;; esac
    ;;
  *) exit 0 ;;
esac
[ -n "$target" ] || exit 0

# Скрипт — из того worktree, где идёт работа; в старой ветке без него — копия рядом с хуком.
dir="$target"
while [ ! -d "$dir" ] && [ "$dir" != / ] && [ "$dir" != . ]; do dir="$(dirname "$dir")"; done
script="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)/scripts/issues.sh"
[ -f "$script" ] || script="$(cd "$(dirname "$0")/../.." && pwd)/scripts/issues.sh"
[ -f "$script" ] || exit 0
if ! reason="$(bash "$script" check "$target" 2>&1)"; then
  . "$(dirname "$0")/lib.sh"; (cd "$dir" && hook_log check-issue "$reason")
  echo "Без взятой задачи работать нельзя (CLAUDE.md, «Задачи»). $reason" >&2
  exit 2
fi
[ -n "$reason" ] && echo "$reason" >&2
exit 0

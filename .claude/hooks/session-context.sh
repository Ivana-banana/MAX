#!/usr/bin/env bash
# SessionStart: stdout попадает в контекст сессии. Показывает, где агент стоит в Git,
# предупреждает о работе в основной копии на main и выводит активные задачи HANDOFF.
# Ничего не блокирует и не ходит в сеть (без git fetch).
set -uo pipefail

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch="$(git branch --show-current 2>/dev/null)"
dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
echo "[git] ветка: ${branch:-detached}; незакоммиченных путей: $dirty; $(git rev-parse --show-toplevel)"

# В связанном worktree git-dir и git-common-dir различаются.
if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] && [ "$branch" = main ]; then
  echo "[git] ВНИМАНИЕ: ты в основной копии на main. Задачу, меняющую файлы, делай в своём worktree:"
  echo "      git worktree add .claude/worktrees/<поток>-<тема> -b worktree-<поток>-<тема> origin/main (GIT.md)"
  [ "$dirty" != 0 ] && echo "      Незакоммиченные изменения здесь могут быть чужими — не коммить и не трогай их."
fi

handoff_rows() { # строки таблицы из раздела HANDOFF.md без шапки
  awk -v s="$1" '/^## /{on=(index($0, s) > 0); next} on && /^\|/' HANDOFF.md | tail -n +3
}

if [ -f HANDOFF.md ]; then
  rows="$(handoff_rows 'Активные задачи')"
  if [ -n "$rows" ]; then
    echo "[HANDOFF] активные задачи (у файла один владелец — чужое не трогать):"
    printf '%s\n' "$rows"
  fi
  rows="$(handoff_rows 'Токен бота')"
  if [ -n "$rows" ]; then
    echo "[HANDOFF] токен бота (один живой потребитель; перед polling или правкой webhook — записаться):"
    printf '%s\n' "$rows"
  fi
fi

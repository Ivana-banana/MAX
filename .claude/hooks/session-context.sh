#!/usr/bin/env bash
# SessionStart: stdout попадает в контекст сессии. Показывает, где агент стоит в Git,
# предупреждает о работе в основной копии на main, выводит держателя токена из HANDOFF.md
# и доску задач из GitHub Issues (scripts/issues.sh board). Ничего не блокирует.
# Нет gh, авторизации или сети — одна строка предупреждения вместо доски.
set -uo pipefail

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch="$(git branch --show-current 2>/dev/null)"
dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
echo "[git] ветка: ${branch:-detached}; незакоммиченных путей: $dirty; $(git rev-parse --show-toplevel)"

# В связанном worktree git-dir и git-common-dir различаются.
if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] && [ "$branch" = main ]; then
  echo "[git] ВНИМАНИЕ: ты в основной копии на main. Задачу, меняющую файлы, делай в своём worktree:"
  echo "      bash scripts/issues.sh take <N>, затем git worktree add .claude/worktrees/<N>-<тема> -b worktree-<N>-<тема> origin/main (GIT.md)"
  [ "$dirty" != 0 ] && echo "      Незакоммиченные изменения здесь могут быть чужими — не коммить и не трогай их."
fi

handoff_rows() { # строки таблицы из раздела HANDOFF.md без шапки
  awk -v s="$1" '/^## /{on=(index($0, s) > 0); next} on && /^\|/' HANDOFF.md | tail -n +3
}

if [ -f HANDOFF.md ]; then
  rows="$(handoff_rows 'Токен бота')"
  if [ -n "$rows" ]; then
    echo "[HANDOFF] токен бота (один живой потребитель; перед polling или правкой webhook — записаться):"
    printf '%s\n' "$rows"
  fi
fi

[ "${SKIP_ISSUES:-0}" = 1 ] && exit 0
[ -f scripts/issues.sh ] || exit 0
if ! command -v gh >/dev/null 2>&1; then
  echo "[issues] нет gh — задачи не видны. Установите GitHub CLI и выполните gh auth login."
  exit 0
fi
if ! timeout 6 gh auth status >/dev/null 2>&1; then
  echo "[issues] gh не авторизован или нет сети — задачи не видны (gh auth login)."
  exit 0
fi
if ! ISSUES_TIMEOUT=6 timeout 15 bash scripts/issues.sh board 2>/dev/null; then
  echo "[issues] GitHub не ответил — занятость не видна (bash scripts/issues.sh mine)."
fi
exit 0

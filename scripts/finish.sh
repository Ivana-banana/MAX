#!/usr/bin/env bash
# Финиш задачи одной командой (GIT.md, «Финиш»), из worktree задачи, всё закоммичено:
#   fetch → merge origin/main → npm test, typecheck, build, demo:check → push ветки
#   → push HEAD:main (fast-forward) → закрыть задачу → pull в основной копии → уборка.
# Конфликт или красная проверка — стоп, ничего не влито. Main ушёл вперёд — до трёх
# попыток с новыми проверками. Force-push нет; чужие ветки и worktree не трогаются.
# Перед запуском покажи ветку свежему reviewer (.claude/agents/reviewer.md).
set -euo pipefail

die() { printf '[finish] %s\n' "$*" >&2; exit 1; }
say() { printf '[finish] %s\n' "$*"; }

branch="$(git branch --show-current)"
n="$(printf '%s' "$branch" | sed -n 's/^worktree-\([0-9][0-9]*\)-.*/\1/p')"
[ -n "$n" ] || die "ветка «$branch» не worktree-<N>-<тема>"
wt="$(git rev-parse --show-toplevel)"
main_copy="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
[ "$wt" != "$main_copy" ] || die "запускай из worktree задачи, не из основной копии"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "есть незакоммиченные правки"
git fetch -q --prune || die "git fetch не прошёл"
[ "$(git rev-list --count --no-merges origin/main..HEAD)" != 0 ] || die "в ветке нет своих коммитов относительно origin/main"

for try in 1 2 3; do
  git merge -q --no-edit origin/main || die "конфликт с main: разреши, закоммить и запусти снова"
  for check in "test" "run typecheck" "run build" "run demo:check"; do
    say "npm $check"
    # shellcheck disable=SC2086
    npm $check || die "npm $check красный — почини до push"
  done
  git push -q -u origin HEAD || die "push ветки не прошёл"
  if git push -q origin HEAD:main 2>/dev/null; then
    break
  fi
  [ "$try" -lt 3 ] || die "main ушёл вперёд три раза подряд: запусти снова"
  say "main ушёл вперёд, повторяю merge и проверки"
  git fetch -q --prune || die "git fetch не прошёл"
done

gh issue close "$n" >/dev/null || say "задачу #$n закрой вручную: gh issue close $n"

cd "$main_copy"
if [ -z "$(git status --porcelain --untracked-files=no)" ] && [ "$(git branch --show-current)" = main ]; then
  git pull -q --ff-only || say "основная копия не обновлена: pull --ff-only не прошёл"
fi
git fetch -q --prune
if [ "$(git rev-list --count "origin/main..$branch")" = 0 ]; then
  git worktree remove "$wt" || die "worktree не убран: $wt"
  git branch -q -D "$branch"
  git push -q origin --delete "$branch" 2>/dev/null || true
  git worktree prune
else
  say "в ветке есть коммиты вне origin/main — worktree оставлен"
fi
say "#$n влита в main, worktree убран"

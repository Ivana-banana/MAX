#!/usr/bin/env bash
# Stop hook: ход не считается завершённым, если в файлах, которые могут попасть
# в коммит (tracked + untracked, не игнорируемые), лежит похожее на секрет значение.
# Секрет в репозитории — нарушение п. 8 ограничений хакатона. См. CLAUDE.md.
# Ложное срабатывание: дописать в строку комментарий `secret-scan: allow`.
# `--git` (pre-commit, .githooks/pre-commit): проверять только индекс, отказ — текст в
# stderr и код 1, а не JSON для Stop-хука.
set -uo pipefail

STAGED=false
[ "${1:-}" = --git ] && STAGED=true

if $STAGED; then
  export GIT_LITERAL_PATHSPECS=1
  mapfile -d '' -t FILES < <(git diff --cached --name-only -z --diff-filter=ACMR 2>/dev/null | grep -zv '^\.claude/hooks/')
else
  mapfile -t FILES < <(git ls-files -co --exclude-standard 2>/dev/null | grep -v '^\.claude/hooks/')
fi
[ "${#FILES[@]}" -eq 0 ] && exit 0

FOUND=""

for f in "${FILES[@]}"; do
  case "$(basename "$f")" in
    .env.example) ;;
    .env|.env.*) FOUND+="$f: файл окружения не в .gitignore"$'\n' ;;
  esac
done

EXISTING=()
if $STAGED; then EXISTING=("${FILES[@]}"); else
  for f in "${FILES[@]}"; do [ -f "$f" ] && EXISTING+=("$f"); done
fi
GREP=(grep -I -n -i -E)
$STAGED && GREP=(git grep --cached -I -n -i -E)

if [ "${#EXISTING[@]}" -gt 0 ]; then
  HITS="$("${GREP[@]}" \
      -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
      -e '(token|secret|password|passwd|api[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_.+/=-]{16,}' \
      -e 'gh[pousr]_[A-Za-z0-9]{36}' \
      -e 'sk-[A-Za-z0-9_-]{20,}' \
      -- "${EXISTING[@]}" 2>/dev/null \
    | grep -v -i -E 'secret-scan: allow|your|example|changeme|placeholder|xxxx|<[a-z_]+>|\$\{|process\.env|os\.environ|getenv' \
    | cut -d: -f1,2)"
  [ -n "$HITS" ] && FOUND+="$(printf '%s' "$HITS" | sed 's/$/: похоже на секрет/')"$'\n'
fi

[ -z "$FOUND" ] && exit 0

if $STAGED; then
  printf '[secrets] в индексе возможные секреты (значения не выводятся):\n%sВынести в .env (в .gitignore) и .env.example с плейсхолдером. Ложное срабатывание — пометить строку `secret-scan: allow`.\n' "$FOUND" >&2
  exit 1
fi

jq -n --arg found "$FOUND" \
  '{decision: "block", reason: ("Возможные секреты в файлах, которые попадут в коммит (значения не выводятся):\n" + $found + "Вынести в .env (в .gitignore) и .env.example с плейсхолдером. Ложное срабатывание — пометить строку `secret-scan: allow`.")}'
exit 0

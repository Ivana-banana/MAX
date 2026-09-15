#!/usr/bin/env bash
# Stop hook: ход не считается завершённым, если тесты проекта красные.
# Стек пока не выбран (CLAUDE.md), поэтому хук сам находит тесты:
# `npm test` в корне и в папках первого уровня с package.json, `pytest` там, где
# есть pyproject.toml и tests/. Нет тестов — молчит. Прогон пропускается, если
# ничего не менялось с последнего зелёного.
set -uo pipefail

MARKER=".claude/.last-green-test-run"

if [ -f "$MARKER" ]; then
  CHANGED="$(find . -type f -newer "$MARKER" \
    -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.claude/*' \
    -not -path '*/.venv/*' -not -path '*/__pycache__/*' -not -path '*/dist/*' 2>/dev/null | head -1)"
  [ -z "$CHANGED" ] && exit 0
fi

RAN=0
OUTPUT=""
STATUS=0

for dir in . */; do
  dir="${dir%/}"
  case "$dir" in node_modules|.git|.claude) continue ;; esac
  if [ -f "$dir/package.json" ] && jq -e '.scripts.test and (.scripts.test | test("no test specified") | not)' "$dir/package.json" >/dev/null 2>&1; then
    RAN=1
    OUT="$(cd "$dir" && npm test --silent 2>&1)" || STATUS=1
    OUTPUT+="== npm test ($dir)"$'\n'"$OUT"$'\n'
  fi
  if [ -f "$dir/pyproject.toml" ] && [ -d "$dir/tests" ]; then
    RAN=1
    PYTEST="python3 -m pytest"
    [ -x "$dir/.venv/bin/pytest" ] && PYTEST=".venv/bin/pytest"
    OUT="$(cd "$dir" && $PYTEST -q 2>&1)" || STATUS=1
    OUTPUT+="== pytest ($dir)"$'\n'"$OUT"$'\n'
  fi
done

[ "$RAN" -eq 0 ] && exit 0

if [ "$STATUS" -eq 0 ]; then
  touch "$MARKER"
  exit 0
fi

TAIL="$(printf '%s' "$OUTPUT" | tail -n 40)"
jq -n --arg out "$TAIL" '{decision: "block", reason: ("Тесты красные перед завершением хода:\n" + $out)}'
exit 0

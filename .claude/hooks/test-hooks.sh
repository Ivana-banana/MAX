#!/usr/bin/env bash
# Проверка Stop-хуков на временном git-репозитории: bash .claude/hooks/test-hooks.sh
set -uo pipefail

HOOKS="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP" && git init -q . && mkdir -p .claude
FAIL=0

expect() { # expect <block|pass> <описание> <хук>
  local out
  out="$(bash "$HOOKS/$3" 2>&1)"
  if [ "$1" = block ] && ! printf '%s' "$out" | grep -q '"decision": *"block"'; then
    echo "FAIL: $2 — ожидалась блокировка, вывод: $out"; FAIL=1
  elif [ "$1" = pass ] && [ -n "$out" ]; then
    echo "FAIL: $2 — ожидался пустой вывод, вывод: $out"; FAIL=1
  else
    echo "ok:   $2"
  fi
}

# --- check-secrets.sh
expect pass  "чистый репозиторий"                   check-secrets.sh
echo 'BOT_TOKEN=your_bot_token_here' > .env.example
expect pass  ".env.example с плейсхолдером"         check-secrets.sh
echo 'const token = "f9a8Xc72kLmQ01zYvB3n4dHs"' > bot.js
expect block "токен в коде"                         check-secrets.sh
echo 'const token = "f9a8Xc72kLmQ01zYvB3n4dHs" // secret-scan: allow' > bot.js
expect pass  "строка с явным secret-scan: allow"    check-secrets.sh
rm bot.js
echo 'BOT_TOKEN=abc' > .env
expect block ".env не в .gitignore"                 check-secrets.sh
echo '.env' > .gitignore
expect pass  ".env в .gitignore"                    check-secrets.sh
printf -- '-----BEGIN RSA PRIVATE KEY-----\n' > key.pem
expect block "приватный ключ"                       check-secrets.sh
rm key.pem

# --- check-tests.sh
expect pass  "тестов нет — хук молчит"              check-tests.sh
cat > package.json <<'EOF'
{"scripts": {"test": "node -e \"process.exit(1)\""}}
EOF
expect block "npm test падает"                      check-tests.sh
cat > package.json <<'EOF'
{"scripts": {"test": "node -e \"process.exit(0)\""}}
EOF
expect pass  "npm test зелёный"                     check-tests.sh
cat > package.json <<'EOF'
{"scripts": {"test": "node -e \"process.exit(1)\""}}
EOF
touch -d '-1 min' package.json
expect pass  "ничего не менялось с зелёного прогона" check-tests.sh

# --- session-context.sh (SessionStart: stdout уходит в контекст)
expect_out() { # expect_out <has|lacks> <описание> <шаблон>
  local out
  out="$(bash "$HOOKS/session-context.sh" 2>&1)"
  if [ "$1" = has ] && ! printf '%s' "$out" | grep -q -- "$3"; then
    echo "FAIL: $2 — нет «$3», вывод: $out"; FAIL=1
  elif [ "$1" = lacks ] && printf '%s' "$out" | grep -q -- "$3"; then
    echo "FAIL: $2 — лишнее «$3», вывод: $out"; FAIL=1
  else
    echo "ok:   $2"
  fi
}
git checkout -q -b main 2>/dev/null
cat > HANDOFF.md <<'EOF'
## Активные задачи

| Владелец | Ветка | Задача | Файлы/контракт | Проверка | Статус |
|---|---|---|---|---|---|
| Codex | worktree-bot-start | Сценарий /start | `bot/` | тест | в работе |

## Токен бота

| С какого момента | Кто | Режим (polling / webhook) | Где запущено |
|---|---|---|---|
| 15.09 12:00 | Alice | polling | ноутбук |

## Блокеры и вопросы
| Дата | Владелец | Блокер |
|---|---|---|
| 2026-09-15 | — | не показывать |
EOF
git add HANDOFF.md && git -c user.name=t -c user.email=t@t commit -q -m init
expect_out has   "основная копия на main — предупреждение" "основной копии"
expect_out has   "активная задача из HANDOFF"              "Сценарий /start"
expect_out lacks "блокеры не попадают в список задач"      "не показывать"
expect_out has   "кто держит токен бота"                   "| Alice | polling"
git worktree add -q .claude/worktrees/wt-test -b worktree-wt-test 2>/dev/null
(cd .claude/worktrees/wt-test && expect_out lacks "worktree — без предупреждения" "основной копии")
(cd .claude/worktrees/wt-test && expect_out has   "worktree — видна ветка"        "worktree-wt-test")

exit $FAIL

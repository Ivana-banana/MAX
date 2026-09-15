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

exit $FAIL

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
  out="$(SKIP_ISSUES=1 bash "$HOOKS/session-context.sh" 2>&1)"
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
expect_out lacks "задачи из HANDOFF не выводятся (они в Issues)" "Сценарий /start"
expect_out lacks "блокеры не попадают в список задач"      "не показывать"
expect_out has   "кто держит токен бота"                   "| Alice | polling"
git worktree add -q .claude/worktrees/wt-test -b worktree-wt-test 2>/dev/null
(cd .claude/worktrees/wt-test && expect_out lacks "worktree — без предупреждения" "основной копии")
(cd .claude/worktrees/wt-test && expect_out has   "worktree — видна ветка"        "worktree-wt-test")

# --- check-issue.sh (PreToolUse: без взятой задачи файлы не меняем)
expect_issue() { # expect_issue <0|2> <описание> <cwd> <json tool_name+tool_input>
  local out code
  out="$(printf '{"cwd":"%s",%s}' "$3" "$4" | bash "$HOOKS/check-issue.sh" 2>&1)"; code=$?
  if [ "$code" != "$1" ]; then echo "FAIL: $2 — код $code, ожидался $1, вывод: $out"; FAIL=1
  else echo "ok:   $2"; fi
}
git worktree add -q .claude/worktrees/7-x -b worktree-7-x 2>/dev/null
for d in . .claude/worktrees/wt-test .claude/worktrees/7-x; do  # скрипт проверки из репозитория
  mkdir -p "$d/scripts" && cp "$HOOKS/../../scripts/issues.sh" "$d/scripts/"
done
expect_issue 2 "issue: правка в основной копии — отказ" "$TMP" '"tool_name":"Edit","tool_input":{"file_path":"a.txt"}'
expect_issue 0 "issue: scratchpad — можно" "$TMP" '"tool_name":"Write","tool_input":{"file_path":"/tmp/x/scratchpad/a.txt"}'
expect_issue 0 "issue: Bash без commit/push — можно" "$TMP" '"tool_name":"Bash","tool_input":{"command":"ls"}'
wt="$TMP/.claude/worktrees/wt-test"
expect_issue 2 "issue: ветка без номера задачи — отказ" "$wt" '"tool_name":"Edit","tool_input":{"file_path":"a.txt"}'
printf 7 > "$(git -C .claude/worktrees/7-x rev-parse --git-dir)/issue-check"
expect_issue 0 "issue: worktree взятой задачи — можно" "$TMP/.claude/worktrees/7-x" '"tool_name":"Bash","tool_input":{"command":"git commit -m x"}'

# --- check-worktrees.sh (SubagentStop: check-secrets.sh в каждом worktree)
expect pass  "worktrees: все чистые — тишина"        check-worktrees.sh
echo 'const token = "f9a8Xc72kLmQ01zYvB3n4dHs"' > .claude/worktrees/7-x/bot.js
expect block "worktrees: секрет в соседнем worktree" check-worktrees.sh
rm .claude/worktrees/7-x/bot.js

# --- protect-config.js (PreToolUse: правка конфига lint — только с разрешения человека)
expect_config() { # expect_config <ask|pass> <описание> <file_path>
  local out
  out="$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$3" | node "$HOOKS/protect-config.js" 2>&1)"
  if [ "$1" = ask ] && ! printf '%s' "$out" | grep -q '"permissionDecision":"ask"'; then
    echo "FAIL: $2 — ожидался запрос разрешения, вывод: $out"; FAIL=1
  elif [ "$1" = pass ] && [ -n "$out" ]; then
    echo "FAIL: $2 — ожидался пустой вывод, вывод: $out"; FAIL=1
  else
    echo "ok:   $2"
  fi
}
echo 'export default [];' > eslint.config.mjs
expect_config ask  "config: правка eslint.config.mjs — спросить человека" "$TMP/eslint.config.mjs"
expect_config pass "config: новый конфиг, которого ещё нет — можно"        "$TMP/.prettierrc"
expect_config pass "config: обычный файл — можно"                          "$TMP/a.txt"
rm eslint.config.mjs

# --- check-upstream.sh: чужие коммиты в origin/main против моей работы
cd "$TMP" && git init -q --bare -b main remote.git
git clone -q remote.git mate 2>/dev/null
mate_push() { # mate_push <файл> <сообщение>
  (cd "$TMP/mate" && echo "$2" >> "$1" && git add "$1" &&
   git -c user.name=mate -c user.email=m@m commit -q -m "$2" && git push -q origin HEAD:main)
}
mate_push README.md "init"
git clone -q remote.git me && cd me && git checkout -q -b worktree-me origin/main
expect_up() { # expect_up <block|pass> <описание> [шаблон]
  local out
  out="$(echo '{}' | bash "$HOOKS/check-upstream.sh" stop 2>&1)"
  if [ "$1" = block ] && ! { printf '%s' "$out" | grep -q '"decision": *"block"' &&
                            printf '%s' "$out" | grep -q -- "$3"; }; then
    echo "FAIL: $2 — ожидалась блокировка с «$3», вывод: $out"; FAIL=1
  elif [ "$1" = pass ] && [ -n "$out" ]; then
    echo "FAIL: $2 — ожидался пустой вывод, вывод: $out"; FAIL=1
  else
    echo "ok:   $2"
  fi
}
expect_up pass  "upstream: новых коммитов нет"
mate_push other.txt "bot: чужой файл"
expect_up pass  "upstream: чужой коммит не пересекается с моими файлами"
echo mine > shared.txt
mate_push shared.txt "api: тот же файл"
expect_up block "upstream: пересечение с незакоммиченным файлом" "shared.txt"
expect_up pass  "upstream: то же состояние origin/main второй раз не блокирует"
echo mine > new.txt && git add new.txt && git -c user.name=me -c user.email=me@me commit -q -m wip
mate_push new.txt "app: тот же новый файл"
expect_up block "upstream: пересечение с закоммиченным в ветке файлом" "new.txt"
mate_push HANDOFF.md "docs: взял задачу"
expect_up block "upstream: изменился HANDOFF — показать всегда" "HANDOFF.md"
mate_push shared.txt "api: ещё правка"
out="$(echo '{}' | bash "$HOOKS/check-upstream.sh" post 2>&1)"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | contains("shared.txt")' >/dev/null 2>&1; then
  echo "ok:   upstream post: факты в additionalContext без блокировки"
else echo "FAIL: upstream post: нет additionalContext, вывод: $out"; FAIL=1; fi
mate_push shared.txt "api: третья правка"
out="$(echo '{}' | bash "$HOOKS/check-upstream.sh" post 2>&1)"
if [ -z "$out" ]; then echo "ok:   upstream post: не чаще раза в 5 минут"
else echo "FAIL: upstream post: сработал раньше 5 минут, вывод: $out"; FAIL=1; fi
git remote set-url origin "$TMP/nope.git"
expect_up pass  "upstream: сеть недоступна — молчит"

# --- .githooks/pre-commit и pre-push (без сети: проверка задачи по ветке и кешу issue-check)
cd "$TMP" && git init -q -b main gh && cd gh
mkdir -p scripts .claude
cp "$HOOKS/../../scripts/issues.sh" scripts/ && cp -r "$HOOKS/../../.githooks" . && cp -r "$HOOKS" .claude/hooks
git config core.hooksPath .githooks && git config user.name t && git config user.email t@t
expect_git() { # expect_git <0|1> <описание> <команда...>
  local want="$1" desc="$2" out code
  shift 2
  out="$("$@" 2>&1)"; code=$?
  if { [ "$want" = 0 ] && [ "$code" != 0 ]; } || { [ "$want" != 0 ] && [ "$code" = 0 ]; }; then
    echo "FAIL: $desc — код $code, ожидался $want, вывод: $out"; FAIL=1
  else echo "ok:   $desc"; fi
}
echo ok > a.txt && git add a.txt scripts .githooks .claude
expect_git 1 "pre-commit: основная копия — отказ" git commit -q -m x
git -c core.hooksPath=/dev/null commit -q -m init   # без хуков: нужен первый коммит для worktree
git worktree add -q wt-nonum -b feature-x
git worktree add -q wt-7 -b worktree-7-x
printf 7 > "$(git -C wt-7 rev-parse --git-dir)/issue-check"   # кеш: задача #7 проверена
echo ok > wt-nonum/b.txt && git -C wt-nonum add b.txt
expect_git 1 "pre-commit: ветка без номера задачи — отказ" git -C wt-nonum commit -q -m x
echo 'BOT_TOKEN=abc' > wt-7/.env && git -C wt-7 add -f .env
expect_git 1 "pre-commit: .env в индексе — отказ" git -C wt-7 commit -q -m x
git -C wt-7 rm -q --cached .env && rm wt-7/.env
echo 'const token = "f9a8Xc72kLmQ01zYvB3n4dHs"' > wt-7/bot.js && git -C wt-7 add bot.js
expect_git 1 "pre-commit: токен в индексе — отказ" git -C wt-7 commit -q -m x
git -C wt-7 rm -q -f --cached bot.js
echo 'BOT_TOKEN=your_bot_token_here' > wt-7/.env.example && git -C wt-7 add .env.example
expect_git 0 "pre-commit: чистый индекс в worktree задачи — можно" git -C wt-7 commit -q -m x
push_in() { # push_in <каталог> <строки stdin>: как git вызывает pre-push
  (cd "$1" && printf '%s\n' "$2" | bash "$TMP/gh/.githooks/pre-push" origin url)
}
Z=0000000000000000000000000000000000000000
S=1111111111111111111111111111111111111111
expect_git 0 "pre-push: только удаление ветки — проходит даже из основной копии" push_in "$TMP/gh" "(delete) $Z refs/heads/worktree-7-x $S"
expect_git 1 "pre-push: обновление ветки из основной копии — отказ" push_in "$TMP/gh" "refs/heads/main $S refs/heads/main $Z"
expect_git 1 "pre-push: ветка без номера задачи — отказ" push_in "$TMP/gh/wt-nonum" "refs/heads/feature-x $S refs/heads/feature-x $Z"
expect_git 0 "pre-push: worktree взятой задачи — можно" push_in "$TMP/gh/wt-7" "refs/heads/worktree-7-x $S refs/heads/worktree-7-x $Z"

# --- scripts/finish.sh: финиш задачи в worktree (npm и gh подменены заглушками в PATH)
cd "$TMP" && git init -q --bare -b main fin-remote.git
git clone -q fin-remote.git fin 2>/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$TMP/fakebin" fin/scripts
cat > "$TMP/fakebin/npm" <<'EOF2'
#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
[ -z "${FAKE_NPM_FAIL:-}" ]
EOF2
cat > "$TMP/fakebin/gh" <<'EOF2'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
EOF2
chmod +x "$TMP/fakebin/npm" "$TMP/fakebin/gh"
export FAKE_LOG="$TMP/fake.log"
cp "$HOOKS/../../scripts/finish.sh" fin/scripts/finish.sh 2>/dev/null
(cd fin && echo a > a.txt && git add . && git commit -q -m init && git push -q origin HEAD:main)
git -C fin worktree add -q .claude/worktrees/9-t -b worktree-9-t origin/main
W="$TMP/fin/.claude/worktrees/9-t"
expect_fin() { # expect_fin <код> <описание> <каталог>
  local out code
  out="$(cd "$3" && PATH="$TMP/fakebin:$PATH" bash scripts/finish.sh 2>&1)"; code=$?
  if [ "$code" != "$1" ]; then echo "FAIL: $2 — код $code, ожидался $1, вывод: $out"; FAIL=1
  else echo "ok:   $2"; fi
}
expect_fin 1 "finish: основная копия — отказ" "$TMP/fin"
expect_fin 1 "finish: нет своих коммитов — отказ" "$W"
echo b > "$W/b.txt" && git -C "$W" add b.txt && git -C "$W" commit -q -m "feat: b"
echo dirty >> "$W/b.txt"
expect_fin 1 "finish: незакоммиченные правки — отказ" "$W"
git -C "$W" checkout -q b.txt
FAKE_NPM_FAIL=1 expect_fin 1 "finish: проверка красная — отказ" "$W"
[ "$(git -C "$TMP/fin-remote.git" rev-parse main)" = "$(git -C "$TMP/fin" rev-parse origin/main)" ] \
  && ! git -C "$TMP/fin-remote.git" log main --format=%s | grep -q "feat: b" \
  && echo "ok:   finish: красная проверка — main не тронут" || { echo "FAIL: finish: main тронут при красной проверке"; FAIL=1; }
mate_push_fin() { (cd "$TMP/fin-remote.git" && git clone -q . "$TMP/fin-mate" 2>/dev/null; cd "$TMP/fin-mate" && echo m > m.txt && git add m.txt && git commit -q -m "mate" && git push -q origin HEAD:main); }
mate_push_fin
: > "$FAKE_LOG"
expect_fin 0 "finish: main ушёл вперёд — merge, проверки, push, закрытие" "$W"
git -C "$TMP/fin-remote.git" log main --format=%s | grep -q "feat: b" && git -C "$TMP/fin-remote.git" log main --format=%s | grep -q "^mate$" \
  && echo "ok:   finish: в main есть и своё, и чужое" || { echo "FAIL: finish: в main нет коммитов"; FAIL=1; }
grep -q "^npm test" "$FAKE_LOG" && grep -q "typecheck" "$FAKE_LOG" && grep -q "run build" "$FAKE_LOG" && grep -q "demo:check" "$FAKE_LOG" \
  && echo "ok:   finish: все четыре проверки запущены" || { echo "FAIL: finish: проверки не все"; FAIL=1; }
grep -q "^gh issue close 9" "$FAKE_LOG" && echo "ok:   finish: задача закрыта" || { echo "FAIL: finish: issue не закрыта"; FAIL=1; }
[ ! -e "$W" ] && ! git -C "$TMP/fin" rev-parse -q --verify worktree-9-t >/dev/null \
  && ! git -C "$TMP/fin-remote.git" rev-parse -q --verify worktree-9-t >/dev/null \
  && echo "ok:   finish: worktree и ветка убраны" || { echo "FAIL: finish: уборка не прошла"; FAIL=1; }
[ -f "$TMP/fin/m.txt" ] && [ -f "$TMP/fin/b.txt" ] && echo "ok:   finish: основная копия подтянута" || { echo "FAIL: finish: основная копия не обновлена"; FAIL=1; }

exit $FAIL

// PreToolUse(Edit|Write|MultiEdit): ask before Claude changes an existing linter/formatter config.
// Idea from ECC config-protection: agents weaken configs to make checks pass.
// Source: hackathon-kit/.claude/hooks/protect-config.js, as ESM (package.json has "type": "module").
import fs from 'node:fs';
import path from 'node:path';

const PROTECTED = /^(\.eslintrc(\..+)?|eslint\.config\..+|\.prettierrc(\..+)?|prettier\.config\..+|biome\.jsonc?|\.?ruff\.toml|\.flake8|mypy\.ini|\.pylintrc|\.stylelintrc(\..+)?|stylelint\.config\..+|\.golangci\.ya?ml|\.clang-tidy)$/;

const f = JSON.parse(fs.readFileSync(0, 'utf8')).tool_input?.file_path;
if (!f || !fs.existsSync(f) || !PROTECTED.test(path.basename(f))) process.exit(0);

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: `Linter/formatter config ${path.basename(f)}: fix the code, not the config. Allow only if the rule itself is wrong.`,
  },
}));

#!/usr/bin/env bash
#
# 校验构建产物能被真正使用。本地和 CI 发布前跑同一份。
#
# Reason: 这个脚本源于 0.2.0 的事故 —— 发到 npm 上的 CLI 装完完全不能用
# （无输出、退出码 0），而当时 typecheck、82 个测试、打包演练全都是绿的。
# 根因是校验方式绕开了真实安装路径：直接跑 dist/main.js，而 npm 装完是通过
# node_modules/.bin 下的符号链接调用的，两者的 process.argv[1] 不同。
# 所以这里必须把 bin 链接到临时目录再执行，才算测到真实路径。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { printf '\033[31mverify: %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

echo "校验构建产物"

# --- 产物存在 -----------------------------------------------------------
for f in \
  packages/schema/dist/index.js \
  packages/core/dist/index.js \
  packages/connectors/dist/index.js \
  packages/connectors/dist/generic-web/index.js \
  packages/connectors/dist/priority-me-blog/index.js \
  apps/cli/dist/main.js \
  apps/cli/dist/bin.js
do
  [ -f "$f" ] || fail "缺少构建产物：$f"
done
ok "七个入口产物齐全"

# bin 路径从 package.json 读，避免脚本与清单各写一份而漂移
BIN_REL="$(node -p "require('./apps/cli/package.json').bin.atlas")"
BIN_PATH="apps/cli/${BIN_REL#./}"
[ -f "$BIN_PATH" ] || fail "package.json 声明的 bin 不存在：$BIN_PATH"

# --- shebang ------------------------------------------------------------
# Reason: bin 丢了 shebang，npm i -g 之后 `atlas` 会被 shell 当脚本执行而报错，
# 用 node 显式调用是发现不了的。
head -1 "$BIN_PATH" | grep -q '^#!/usr/bin/env node' \
  || fail "$BIN_PATH 缺少 shebang，bin 入口不可执行"
ok "bin 入口带 shebang"

# --- 能脱离 tsx 独立运行 -------------------------------------------------
node "$BIN_PATH" help >/dev/null || fail "构建产物无法运行：node $BIN_PATH help"
ok "产物可脱离 tsx 独立运行"

# --- 经符号链接调用（0.2.0 的失败点）------------------------------------
LINK_DIR="$(mktemp -d)"
trap 'rm -rf "$LINK_DIR"' EXIT
ln -s "$ROOT/$BIN_PATH" "$LINK_DIR/atlas"
node "$LINK_DIR/atlas" help > "$LINK_DIR/out.txt" 2>&1 || true
[ -s "$LINK_DIR/out.txt" ] \
  || fail "经 bin 符号链接调用时无输出，入口不会执行（npm 安装后 \`atlas\` 会是个空操作）"
ok "经 bin 符号链接调用正常"

printf '\033[32m产物校验通过\033[0m\n'

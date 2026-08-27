#!/usr/bin/env bash
#
# 把 @pr-lore/* 四个包发布到 npmjs.org。
#
#   scripts/release.sh --dry-run          # 走完全部检查与打包，但不真的发布
#   scripts/release.sh                    # 发布 package.json 里当前的版本
#   scripts/release.sh --version 0.3.0    # 先把所有包统一改成 0.3.0，提交，再发布
#   scripts/release.sh --otp 123456       # 账号开了双因子时透传验证码
#
# 设计取舍：
# - 只发 npmjs.org。仓库 .npmrc 指向 npmmirror 镜像（只读），所以每条 npm/pnpm
#   命令都显式带 --registry，不依赖环境里恰好是什么源。
# - 失败即停。宁可中途报错，也不要发出一个没跑过测试或没构建干净的包。
# - 可重复执行。pnpm 会跳过 registry 上已存在的版本，所以中途失败后重跑是安全的。

set -euo pipefail

REGISTRY="https://registry.npmjs.org/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
NEW_VERSION=""
OTP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --version) NEW_VERSION="${2:-}"; shift 2 ;;
    --otp)     OTP="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release: 未知参数 $1（可用：--dry-run / --version <x.y.z> / --otp <code>）" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mrelease: %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. 仓库状态 ---------------------------------------------------------
step "检查仓库状态"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "当前在 $BRANCH 分支，请先切回 main 再发布"

[ -z "$(git status --porcelain)" ] || fail "工作区有未提交的改动，请先提交或 stash"

git fetch origin main --quiet
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] || fail "本地 main 与 origin/main 不一致，请先 pull / push"

echo "main @ $(git rev-parse --short HEAD)，工作区干净，与 origin 同步"

# --- 2. 登录态 -----------------------------------------------------------
step "检查 npmjs.org 登录态"

# Reason: 仓库 .npmrc 把 registry 指向了 npmmirror 镜像，镜像是只读的。
# 这里显式对官方源查登录态，避免「以为登录了、其实登录的是别的源」。
if ! NPM_USER="$(pnpm whoami --registry "$REGISTRY" 2>/dev/null)"; then
  fail "未登录 npmjs.org。请先运行：npm login --registry $REGISTRY"
fi
echo "已登录为 $NPM_USER"

# --- 3. 版本 -------------------------------------------------------------
if [ -n "$NEW_VERSION" ]; then
  step "把所有包版本改为 $NEW_VERSION"
  echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
    || fail "版本号格式不对：$NEW_VERSION"

  pnpm -r exec npm pkg set version="$NEW_VERSION"
  npm pkg set version="$NEW_VERSION"

  git add -A
  git commit -m "chore: release v$NEW_VERSION"
  echo "已提交版本变更"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
step "准备发布 $TAG"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  fail "tag $TAG 已存在。用 --version 指定一个新版本，或先删掉这个 tag"
fi

# 四个包的版本必须与根一致，否则 workspace:* 改写出来的依赖会指向不存在的版本
MISMATCH="$(pnpm -r --silent exec node -p \
  "require('./package.json').version === '$VERSION' ? '' : require('./package.json').name" \
  | tr -d '[:blank:]' | grep -v '^$' | paste -sd, - || true)"
[ -z "$MISMATCH" ] || fail "这些包的版本与根 package.json 的 $VERSION 不一致：$MISMATCH"

# --- 4. 质量门 -----------------------------------------------------------
step "typecheck"
pnpm typecheck

step "test"
pnpm test

step "干净构建"
pnpm rebuild

# --- 5. 产物校验 ---------------------------------------------------------
step "校验构建产物"

for f in \
  packages/schema/dist/index.js \
  packages/core/dist/index.js \
  packages/connectors/dist/index.js \
  packages/connectors/dist/generic-web/index.js \
  packages/connectors/dist/priority-me-blog/index.js \
  apps/cli/dist/main.js
do
  [ -f "$f" ] || fail "缺少构建产物：$f"
done

# Reason: bin 入口丢了 shebang 的话，npm i -g 之后 `lore` 会被 shell 当脚本执行而报错，
# 而这在本地用 node 直接跑是发现不了的。
head -1 apps/cli/dist/main.js | grep -q '^#!/usr/bin/env node' \
  || fail "apps/cli/dist/main.js 缺少 shebang，bin 入口会不可执行"

# 产物必须能脱离 tsx 独立运行
node apps/cli/dist/main.js help >/dev/null || fail "构建产物无法运行：node apps/cli/dist/main.js help"

echo "产物齐全，CLI 可独立运行"

# --- 6. 打包演练 ---------------------------------------------------------
step "打包演练（dry-run）"
pnpm -r publish --dry-run --access public --registry "$REGISTRY" --no-git-checks

if [ "$DRY_RUN" = "1" ]; then
  printf '\n\033[32m演练完成，未发布。去掉 --dry-run 即可真正发布 %s\033[0m\n' "$TAG"
  exit 0
fi

# --- 7. 发布 -------------------------------------------------------------
step "发布到 npmjs.org"

PUBLISH_ARGS=(--access public --registry "$REGISTRY")
[ -n "$OTP" ] && PUBLISH_ARGS+=(--otp "$OTP")

# pnpm 会按拓扑序发布，把 workspace:* 改写成具体版本，并跳过 registry 上已存在的版本，
# 因此中途失败后重跑这个脚本是安全的。
pnpm -r publish "${PUBLISH_ARGS[@]}"

# --- 8. 打 tag -----------------------------------------------------------
step "打 tag 并推送"
git tag -a "$TAG" -m "Release $TAG"
git push origin main --follow-tags

step "校验 registry"
for p in schema core connectors cli; do
  PUBLISHED="$(npm view "@pr-lore/$p" version --registry "$REGISTRY" 2>/dev/null || echo '(查询失败)')"
  printf '  @pr-lore/%-11s %s\n' "$p" "$PUBLISHED"
done

printf '\n\033[32m%s 发布完成\033[0m\n' "$TAG"

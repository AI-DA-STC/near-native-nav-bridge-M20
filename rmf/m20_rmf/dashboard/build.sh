#!/usr/bin/env bash
# Build the operator dashboard into dist/ (served by `m20_rmf ui` on :8080).
# Runs in the `web` devcontainer (.devcontainer/web); scripts/m20_stack.sh dashboard
# starts that and calls this. Needs internet the first time (clone + packages).
#
# Our sources (src/) are copied next to Open-RMF's demo inside rmf-dashboard-framework
# and built with its own Vite config, exactly like the demo: the framework, React and MUI
# then resolve to one copy each.
set -euo pipefail
cd "$(dirname "$0")"
RMF_WEB_COMMIT=85a34c3ec6481796d7c0eba745d9221055121656     # rmf-web, branch jazzy
export npm_config_store_dir="$HOME/.pnpm-store"              # not inside the repo
if [ ! -d rmf-web ]; then
  git clone --quiet --filter=blob:none --branch jazzy https://github.com/open-rmf/rmf-web rmf-web
fi
( cd rmf-web
  if [ "$(git rev-parse HEAD)" != "$RMF_WEB_COMMIT" ]; then
    git fetch --quiet origin jazzy && git checkout --quiet "$RMF_WEB_COMMIT"; rm -rf node_modules
  fi
  if [ ! -d node_modules ]; then
    corepack pnpm install --store-dir "$npm_config_store_dir" --package-import-method copy \
      --filter="rmf-dashboard-framework..." --filter="!pipenv-install" \
      --filter="!api-server" --filter="!ros-translator"
    corepack pnpm --filter="rmf-dashboard-framework^..." build
  fi )
FW=rmf-web/packages/rmf-dashboard-framework
rm -rf "$FW/examples/m20" && cp -r src "$FW/examples/m20"
( cd "$FW/examples/m20" && ../../node_modules/.bin/vite build -c ../shared/vite.config.ts \
    --outDir "$PWD/../../../../../dist" --emptyOutDir )
echo "dashboard built: $(pwd)/dist"

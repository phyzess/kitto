#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ $# -eq 0 && -t 0 && -t 1 ]] || [[ $# -eq 1 && $1 == --interactive ]]; then
    if [[ -t 0 && -t 1 && ! -d "$SCRIPT_DIR/node_modules/@clack/prompts" ]]; then
        npm install --prefix "$SCRIPT_DIR" --ignore-scripts --no-audit --no-fund
    fi
    exec node "$SCRIPT_DIR/bin/kitto.mjs" setup --interactive
fi

for arg in "$@"; do
    case "$arg" in
        -h|--help) cat <<'HELP'
./setup.sh                在终端启动 Kitto 环境配置向导
./setup.sh --interactive  显式使用向导
./setup.sh --dry-run      预览旧版 Pi 配置同步
./setup.sh --force        运行旧版 Pi 配置同步

兼容旧版自动化：无终端且无参数时，按原方式执行 Pi 的 deps 和 pull。
HELP
            exit 0 ;;
    esac
done

echo ""
echo "=========================================="
echo "  pi-config setup"
echo "  = deps + pull"
echo "=========================================="
echo ""

bash "$SCRIPT_DIR/sync.sh" deps "$@"
bash "$SCRIPT_DIR/sync.sh" pull "$@"

echo "仍需手动:"
echo "1. 密钥: 编辑 ~/.pi-agent-env（gitlab / atlassian / figma token）"
echo "2. 私有 MCP: cp config/pi/mcp.private.example.json config/pi/mcp.private.json 填 host 后重跑 sync.sh pull"
echo "3. 校验: pi list && pi mcp list"
echo "4. 重启 pi: pi"
echo ""

#!/usr/bin/env bash
# ============================================================
# pi-config setup — 首次在新机器上复刻 pi agent 环境
#
#   bash setup.sh            装依赖 + 部署缺失/不一致的文件
#   bash setup.sh --force    兼容旧参数（pull 本就按内容覆盖）
#   bash setup.sh --dry-run  只打印动作，不落盘
#
# 等价于:  bash sync.sh deps && bash sync.sh pull
# 之后日常同步用 sync.sh（status / pull / push）。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for arg in "$@"; do
    case "$arg" in
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
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

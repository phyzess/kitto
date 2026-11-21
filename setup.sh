#!/usr/bin/env bash
# One public setup entry: delegate to the Kitto JS setup command.
# sync.sh is an internal Pi adapter and is never called from here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for arg in "$@"; do
    case "$arg" in
        -h|--help) cat <<'HELP'
./setup.sh                   启动 Kitto 配置向导（终端）或执行非交互 setup
./setup.sh --interactive     显式启动向导
./setup.sh --dry-run         预览部署，不写盘
./setup.sh --force           已废弃：打印警告后按普通 setup 运行（幂等）

其余参数原样传给 `node bin/kitto.mjs setup`：
  --agents pi,codex,dsh        选择宿主
  --source PATH_OR_GIT_URL     配置来源
  --ref BRANCH_OR_TAG          固定配置版本
  --global                     只配置全局规则与 skills
  --workspace PATH             登记工作区
  --workspace-parent PATH      登记工作区父目录
  --dsh-profile PROFILE        DSH 配置档（web/headless/desktop 等）
  --dsh-service UNIT           为 DSH 系统服务配置
  --install-agents             补装缺少的宿主 CLI
  --recover                    恢复上一份可用的 Kitto 代码

setup.sh 只负责进入 `kitto setup`；Pi 配置由 Kitto 统一部署，不要再直接调用 sync.sh。
HELP
            exit 0 ;;
    esac
done

# Drop the deprecated --force flag and warn once. Kitto setup is already idempotent.
args=()
force_seen=0
for arg in "$@"; do
    case "$arg" in
        --force|-f)
            if [ "$force_seen" = 0 ]; then
                printf '%s[warn]%s --force 已废弃：Kitto setup 本身幂等，本次按普通 setup 继续。\n' \
                    $'\033[0;33m' $'\033[0m' >&2
                force_seen=1
            fi
            ;;
        *) args+=("$arg") ;;
    esac
done

# Install the wizard UI only for an actual interactive terminal run.
wizard=0
if [ "${#args[@]}" -eq 0 ]; then
    if [ -t 0 ] && [ -t 1 ]; then wizard=1; fi
elif [ "${#args[@]}" -eq 1 ] && [ "${args[0]}" = "--interactive" ]; then
    wizard=1
fi

if [ "$wizard" = 1 ] && [ -t 0 ] && [ -t 1 ] && [ ! -d "$SCRIPT_DIR/node_modules/@clack/prompts" ]; then
    npm install --prefix "$SCRIPT_DIR" --ignore-scripts --no-audit --no-fund
fi

# Bash 3.2 (macOS) rejects expanding an empty array under `set -u`.
if [ "${#args[@]}" -eq 0 ]; then
    exec node "$SCRIPT_DIR/bin/kitto.mjs" setup
fi
exec node "$SCRIPT_DIR/bin/kitto.mjs" setup "${args[@]}"

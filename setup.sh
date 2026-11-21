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
./setup.sh --dry-run         预览 Kitto setup 计划，不写盘（旧 Pi 预览路径已移除）
./setup.sh --force           已废弃：警告一次，按旧的非交互语义运行 setup

没有 state 的源码 checkout 首次安装时用 `./setup.sh --source .`；
本机已 setup 过则直接 `./setup.sh`，会复用 state 中记录的配置源。

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

# --force keeps its historical non-interactive meaning. Scan first so a trailing
# --force also suppresses a preceding --interactive. Warn exactly once.
force_seen=0
for arg in "$@"; do
    case "$arg" in
        --force|-f) force_seen=1 ;;
    esac
done
if [ "$force_seen" = 1 ]; then
    printf '%s[warn]%s --force 已废弃：按旧的非交互语义运行 setup（忽略交互向导）。\n' \
        $'\033[0;33m' $'\033[0m' >&2
fi

# Keep every argument except the deprecated flag; --force disables the wizard.
args=()
for arg in "$@"; do
    case "$arg" in
        --force|-f) ;;
        --interactive) [ "$force_seen" = 1 ] || args+=("$arg") ;;
        *) args+=("$arg") ;;
    esac
done

# Install the wizard UI only for an actual interactive terminal run.
wizard=0
if [ "$force_seen" = 0 ]; then
    if [ "${#args[@]}" -eq 0 ]; then
        if [ -t 0 ] && [ -t 1 ]; then wizard=1; fi
    elif [ "${#args[@]}" -eq 1 ] && [ "${args[0]}" = "--interactive" ]; then
        wizard=1
    fi
fi

if [ "$wizard" = 1 ] && [ -t 0 ] && [ -t 1 ] && [ ! -d "$SCRIPT_DIR/node_modules/@clack/prompts" ]; then
    npm install --prefix "$SCRIPT_DIR" --ignore-scripts --no-audit --no-fund
fi

# Bash 3.2 (macOS) rejects expanding an empty array under `set -u`.
if [ "${#args[@]}" -eq 0 ]; then
    if [ "$force_seen" = 1 ]; then
        # bin/kitto.mjs starts the wizard when stdin and stdout are TTYs. Detach
        # stdin so the deprecated --force stays non-interactive in a terminal.
        exec node "$SCRIPT_DIR/bin/kitto.mjs" setup </dev/null
    fi
    exec node "$SCRIPT_DIR/bin/kitto.mjs" setup
fi
exec node "$SCRIPT_DIR/bin/kitto.mjs" setup "${args[@]}"

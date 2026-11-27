#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${KITTO_CONFIG_ROOT:-$SCRIPT_ROOT}"
DOT_PI="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DOT_AGENTS="${PI_AGENTS_DIR:-$HOME/.agents}"
LOCAL="$ROOT/config/pi/local"
COMMON_AGENTS="$ROOT/config/instructions/common.md"
PI_AGENTS="$ROOT/config/pi/AGENTS.md"
PY="$SCRIPT_ROOT/lib/pi_config.py"
HOST="$(hostname -s 2>/dev/null || hostname)"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'
YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
info() { printf '%s[info]%s %s\n' "$CYAN" "$NC" "$*"; }
ok()   { printf '%s[ok]%s   %s\n' "$GREEN" "$NC" "$*"; }
same() { printf '%s[=]%s    %s\n' "$DIM" "$NC" "$*"; }
warn() { printf '%s[skip]%s %s\n' "$YELLOW" "$NC" "$*"; }
fail() { printf '%s[fail]%s %s\n' "$RED" "$NC" "$*"; }
deprecated() { printf '%s[deprecated]%s %s\n' "$YELLOW" "$NC" "$*"; }

case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      PLATFORM=unknown ;;
esac

DRY=0
COMMIT=0
CMD="${1:-status}"
shift || true
for arg in "$@"; do
    case "$arg" in
        --dry-run|-n) DRY=1 ;;
        --commit)     COMMIT=1 ;;
        --force|-f)   ;;
        -h|--help)    printf '%s\n' '# ============================================================
# sync.sh — Kitto 内部的 Pi 适配器（仓库 <-> 本机）
#
# 这是 `lib/kitto.mjs` 的 syncCommand 调用的内部实现，不是公开入口。
# 直接 `bash sync.sh` 会打印 deprecated 警告；请用 `kitto setup`，
# 或在 Kitto 会话里让维护 skill 执行 sync。
#
# 兼容保留的命令（settings/mcp/AGENTS.md/extensions/packages 仍可用）：
#   bash sync.sh status           看仓库与本机差异（只读）
#   bash sync.sh pull             仓库 -> 本机（内容不同才覆盖；settings/mcp 走结构化合并）
#   bash sync.sh push             本机 -> 仓库（脱敏导出，运行时键与私钥不落盘；
#                                 AGENTS.md 只导出 Pi 专属段，共享规则不回写）
#   bash sync.sh push --commit    导出并提交
#   bash sync.sh deps             按平台装 CLI 依赖（brew / mise / npm / pip）
#
# 共享 skills（~/.agents/skills）由 Kitto JS 管理（hash 所有权 + 锁）。
# 直接运行 sync.sh 默认跳过；确需旧行为时显式设置：
#   KITTO_ALLOW_LEGACY_SKILL_SYNC=1 bash sync.sh pull
#
# 机器专属配置放 config/pi/local/（gitignore），不会回流到仓库：
#   packages.txt       本机额外 pi 包
#   packages.skip.txt  不装的包（如与已有扩展工具名冲突）
#   settings.json      覆盖仓库 settings 的键
#   mcp.json           本机额外 / 覆盖的 MCP 服务器'; exit 0 ;;
        *)            fail "unknown option: $arg"; exit 2 ;;
    esac
done

if [ "${KITTO_SHARED_SKILLS_MANAGED:-0}" != 1 ]; then
    deprecated "deprecated direct entry; use kitto setup/sync (or the Kitto maintenance skill) instead."
    if [ "${KITTO_ALLOW_LEGACY_SKILL_SYNC:-0}" != 1 ]; then
        deprecated "shared skills ~/.agents/skills are managed by Kitto JS; opt in with KITTO_ALLOW_LEGACY_SKILL_SYNC=1 only for legacy compatibility."
    fi
fi

TMP="$(mktemp -d)"
LOCK=""
cleanup() {
    rm -rf "$TMP"
    [ -z "$LOCK" ] || rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
lock_holder_state() {
    local pid="$1" status=0
    [[ "$pid" =~ ^[0-9]+$ ]] || { echo unknown; return; }
    if kill -0 "$pid" 2>/dev/null; then echo alive; return; fi
    command -v ps >/dev/null 2>&1 || { echo unknown; return; }
    ps -p "$pid" >/dev/null 2>&1 || status=$?
    case "$status" in
        0) echo alive ;;
        1) echo dead ;;
        *) echo unknown ;;
    esac
}

if [ "$DRY" = 0 ] && [[ "$CMD" =~ ^(pull|push|deps)$ ]]; then
    mkdir -p "$LOCAL"
    if ! mkdir "$LOCAL/.sync-lock" 2>/dev/null; then
        holder=""
        if [ -f "$LOCAL/.sync-lock/pid" ]; then
            holder="$(cat "$LOCAL/.sync-lock/pid" 2>/dev/null)"
        fi
        holder_state=""
        [ -z "$holder" ] || holder_state="$(lock_holder_state "$holder")"
        if [ "$holder_state" = alive ]; then
            fail "另一个同步操作仍在运行（pid $holder）。等它结束后重试。"
        elif [ "$holder_state" = dead ]; then
            fail "残留的同步锁：pid $holder 已退出。重跑命令并加 --break-lock 自动清理，或 rm -rf $LOCAL/.sync-lock"
        elif [ -n "$holder" ]; then
            fail "无法确认同步锁持有者（pid $holder）是否仍在运行。不要删除 $LOCAL/.sync-lock；确认该进程已结束后再手动处理。"
        else
            fail "$LOCAL/.sync-lock 存在但没有 pid 记录（旧版 Kitto 留下的）。确认没有进程在写后 rm -rf $LOCAL/.sync-lock"
        fi
        exit 1
    fi
    LOCK="$LOCAL/.sync-lock"
    printf '%s\n' "$$" > "$LOCK/pid"
fi

run() {
    if [ "$DRY" = 1 ]; then info "[dry-run] $*"; else "$@"; fi
}


json_same() {
    python3 - "$1" "$2" <<'PY'
import json, sys
def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None
sys.exit(0 if load(sys.argv[1]) == load(sys.argv[2]) else 1)
PY
}

show_json_diff() {
    if json_same "$1" "$2"; then
        same "$3（内容一致，仅格式差异）"
    else
        diff -u "$1" "$2" | sed -n '3,60p' | sed 's/^/    /' || true
    fi
}


deploy_file() {
    local src="$1" dst="$2" label="${3:-$2}"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then same "$label"; return 0; fi
    if [ -f "$dst" ]; then info "update $label"; else info "create $label"; fi
    run mkdir -p "$(dirname "$dst")"
    run cp -f "$src" "$dst"
}

pi_agents_source() {
    local out="$1"
    python3 "$PY" compose-agents "$COMMON_AGENTS" "$PI_AGENTS" "$out" || return 1
    printf '%s\n' "$out"
}

deploy_pi_agents() {
    local src
    if [ -f "$COMMON_AGENTS" ]; then
        src="$(pi_agents_source "$TMP/AGENTS.md")" || { fail "组合 $COMMON_AGENTS 与 $PI_AGENTS 失败"; return 1; }
    else
        src="$PI_AGENTS"
    fi
    deploy_file "$src" "$DOT_PI/AGENTS.md" "~/.pi/agent/AGENTS.md"
}

prepare_pi_agents_export() {
    if [ ! -f "$COMMON_AGENTS" ]; then
        python3 "$PY" legacy-agents "$DOT_PI/AGENTS.md" "$TMP/AGENTS.md" \
            || { fail "配置源没有共享层，但本机 AGENTS.md 已含共享段；拒绝整文件导出"; return 1; }
        return 0
    fi
    info "AGENTS.md（只导出 Pi 专属段）"
    python3 "$PY" extract-agents "$DOT_PI/AGENTS.md" "$COMMON_AGENTS" "$TMP/AGENTS.md" \
        || { fail "AGENTS.md 未按共享层组合，拒绝把 common 写回 config/pi/AGENTS.md"; return 1; }
}

deploy_pi_agents_export() {
    deploy_file "$TMP/AGENTS.md" "$PI_AGENTS" "config/pi/AGENTS.md"
}

deploy_dir() {
    local src="$1" dst="$2" label="${3:-$2}"
    if [ -L "$dst" ]; then
        warn "$label 是指向别处的软链，保持不动"
        return 0
    fi
    if [ -d "$dst" ] && diff -rq "$src" "$dst" >/dev/null 2>&1; then same "$label"; return 0; fi
    if [ -d "$dst" ]; then info "update $label"; else info "create $label"; fi
    if [ -d "$dst" ]; then run rm -rf "$dst"; fi
    run mkdir -p "$(dirname "$dst")"
    run cp -R "$src" "$dst"
}

ext_skipped() {
    case "$PLATFORM:$1" in
        linux:herdr-agent-state.ts) return 0 ;;
        *) return 1 ;;
    esac
}


step_packages() {
    info "pi 扩展包"
    if ! command -v pi >/dev/null 2>&1; then
        warn "pi 未安装，跳过（先装 @earendil-works/pi-coding-agent）"
        return 0
    fi
    local installed pkg packages
    packages="$(python3 "$PY" list-shared-packages "$ROOT/config/pi/settings.json" "$LOCAL/packages.skip.txt")" || return 1
    installed="$(pi list 2>/dev/null || true)"
    while IFS= read -r pkg; do
        [ -z "$pkg" ] && continue
        if grep -qF -- "$pkg" <<<"$installed"; then same "$pkg"; continue; fi
        info "pi install $pkg"
        run pi install "$pkg" || { fail "pi install $pkg 失败"; return 1; }
    done <<<"$packages"
}

step_settings() {
    local out="$DOT_PI/settings.json" target="$DOT_PI/settings.json"
    [ "$DRY" = 1 ] && target="$TMP/settings.json"
    info "settings.json"
    if [ "$DRY" = 1 ] && [ -f "$out" ]; then
        python3 "$PY" merge-settings "$ROOT/config/pi/settings.json" "$out" "$LOCAL" "$target" >/dev/null
        show_json_diff "$out" "$target" "settings.json"
    else
        python3 "$PY" merge-settings "$ROOT/config/pi/settings.json" "$out" "$LOCAL" "$target"
    fi
    if [ "$DRY" = 0 ]; then
        python3 "$PY" record-settings "$ROOT/config/pi/settings.json" "$out" "$LOCAL"
    fi
}

step_mcp() {
    local out="$DOT_PI/mcp.json" target="$DOT_PI/mcp.json"
    [ "$DRY" = 1 ] && target="$TMP/mcp.json"
    info "mcp.json"
    python3 "$PY" merge-mcp \
        "$ROOT/config/pi/mcp.json" \
        "$ROOT/config/pi/platform/$PLATFORM/mcp.json" \
        "$LOCAL/mcp.json" \
        "$out" "$target"
    local private="$ROOT/config/pi/mcp.private.json"
    if [ -f "$private" ] && ! grep -q 'YOUR_' "$private"; then
        python3 "$PY" merge-mcp "$target" "$private" "" "" "$target" | sed 's/^/    /'
    elif [ -f "$private" ]; then
        warn "mcp.private.json 还含 YOUR_* 占位符，跳过"
    fi
    if [ "$DRY" = 1 ] && [ -f "$out" ]; then
        show_json_diff "$out" "$target" "mcp.json"
    fi
}

step_extensions() {
    info "extensions"
    local ext name
    for ext in "$ROOT"/config/pi/extensions/*.ts; do
        [ -e "$ext" ] || continue
        name="$(basename "$ext")"
        ext_skipped "$name" && { warn "${name}（$PLATFORM 不适用）"; continue; }
        deploy_file "$ext" "$DOT_PI/extensions/$name" "~/.pi/agent/extensions/$name"
    done
}

step_skills() {
    [ "${KITTO_SHARED_SKILLS_MANAGED:-0}" = 1 ] && return 0
    if [ "${KITTO_ALLOW_LEGACY_SKILL_SYNC:-0}" != 1 ]; then
        warn "shared skills（~/.agents/skills）由 Kitto JS 管理，直接 sync.sh 跳过部署"
        info "确需旧行为: KITTO_ALLOW_LEGACY_SKILL_SYNC=1 bash sync.sh pull"
        return 0
    fi
    info "skills（legacy direct-sync，KITTO_ALLOW_LEGACY_SKILL_SYNC=1）"
    run mkdir -p "$DOT_AGENTS/skills"
    local dir name
    for dir in "$ROOT"/skills/*/; do
        [ -d "$dir" ] || continue
        name="$(basename "$dir")"
        deploy_dir "$dir" "$DOT_AGENTS/skills/$name" "~/.agents/skills/$name"
    done
}

step_env() {
    info "环境变量"
    if [ -e "$HOME/.pi-agent-env" ] || [ -L "$HOME/.pi-agent-env" ]; then
        same "~/.pi-agent-env（保留本机内容）"
    else
        deploy_file "$ROOT/config/env.example" "$HOME/.pi-agent-env" "~/.pi-agent-env"
        run chmod 600 "$HOME/.pi-agent-env"
    fi
    local rc shell="${SHELL:-}"
    case "${shell##*/}" in
        zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
        bash) rc="$HOME/.bashrc" ;;
        *) warn '请在你的 shell 启动文件中加载 ~/.pi-agent-env'; return 0 ;;
    esac
    if [ ! -f "$rc" ]; then
        warn "启动文件不存在，请手动配置 $rc 加载 ~/.pi-agent-env"
        return 0
    fi
    if [ -f "$rc" ] && ! grep -q 'pi-agent-env' "$rc"; then
        info "在 $(basename "$rc") 里加 source ~/.pi-agent-env"
        if [ "$DRY" = 1 ]; then
            info "[dry-run] append source line to $rc"
        else
            printf '\n# pi-config: MCP / provider tokens\n[ -f "$HOME/.pi-agent-env" ] && . "$HOME/.pi-agent-env"\n' >> "$rc"
        fi
    fi
}


cmd_pull() {
    printf '\n%s==> pull%s  仓库 %s -> 本机 %s (platform: %s)\n\n' "$CYAN" "$NC" "$ROOT" "$DOT_PI" "$PLATFORM"
    run mkdir -p "$LOCAL" "$DOT_PI/extensions"
    step_packages
    step_settings
    step_mcp
    deploy_pi_agents
    deploy_file "$ROOT/config/pi/i-have-adhd-always" "$DOT_PI/.i-have-adhd-always" "~/.pi/agent/.i-have-adhd-always"
    step_extensions
    step_skills
    step_env
    echo
    if [ "$DRY" = 1 ]; then
        ok "dry-run 结束，未落盘"
    else
        ok "pull 完成（新会话或 /reload 生效）"
        if command -v pi >/dev/null 2>&1; then info "校验: pi list && pi mcp list"; fi
    fi
}

cmd_push() {
    printf '\n%s==> push%s  本机 %s -> 仓库 %s (platform: %s, host: %s)\n\n' "$CYAN" "$NC" "$DOT_PI" "$ROOT" "$PLATFORM" "$HOST"
    [ -f "$DOT_PI/settings.json" ] || { fail "本机没有 settings.json"; exit 1; }
    if [ "$COMMIT" = 1 ] && ! git -C "$ROOT" diff --cached --quiet; then
        fail "暂存区已有改动，请先处理后再使用 --commit"
        exit 1
    fi
    prepare_pi_agents_export || exit 1
    info "settings.json（脱敏）"
    if [ "$DRY" = 1 ]; then
        python3 "$PY" sanitize-settings "$DOT_PI/settings.json" "$ROOT/config/pi/settings.json" "$LOCAL" "$TMP/settings.json"
        show_json_diff "$ROOT/config/pi/settings.json" "$TMP/settings.json" "config/pi/settings.json"
    else
        python3 "$PY" sanitize-settings "$DOT_PI/settings.json" "$ROOT/config/pi/settings.json" "$LOCAL" "$ROOT/config/pi/settings.json"
    fi
    deploy_pi_agents_export
    [ -f "$DOT_PI/mcp.json" ] && {
        info "mcp.json（去掉平台/本机/私有条目）"
        if [ "$DRY" = 1 ]; then
            python3 "$PY" export-mcp "$ROOT/config/pi/mcp.json" "$DOT_PI/mcp.json" "$ROOT/config/pi/platform/$PLATFORM/mcp.json" "$LOCAL/mcp.json" "$ROOT/config/pi/mcp.private.json" "$TMP/mcp.json"
            show_json_diff "$ROOT/config/pi/mcp.json" "$TMP/mcp.json" "config/pi/mcp.json"
        else
            python3 "$PY" export-mcp "$ROOT/config/pi/mcp.json" "$DOT_PI/mcp.json" "$ROOT/config/pi/platform/$PLATFORM/mcp.json" "$LOCAL/mcp.json" "$ROOT/config/pi/mcp.private.json" "$ROOT/config/pi/mcp.json"
        fi
    }
    local ext name
    for ext in "$DOT_PI"/extensions/*.ts; do
        [ -f "$ext" ] || continue
        name="$(basename "$ext")"
        [ -f "$ROOT/config/pi/extensions/$name" ] || { warn "${name}（未托管，跳过）"; continue; }
        case "$name" in herdr-agent-state.ts) warn "${name}（herdr 托管，不入库）"; continue ;; esac
        deploy_file "$ext" "$ROOT/config/pi/extensions/$name" "config/pi/extensions/$name"
    done
    local dir sname
    for dir in "$DOT_AGENTS"/skills/*/; do
        [ -d "$dir" ] || continue
        [ -L "${dir%/}" ] && { warn "$(basename "$dir")（软链，跳过）"; continue; }
        sname="$(basename "$dir")"
        [ -f "$ROOT/skills/$sname/SKILL.md" ] || { warn "${sname}（未托管，跳过）"; continue; }
        deploy_dir "$dir" "$ROOT/skills/$sname" "skills/$sname"
    done
    echo
    if [ "$DRY" = 1 ]; then
        info "[dry-run] git -C $ROOT status --short"; exit 0
    fi
    git -C "$ROOT" status --short || true
    if [ "$COMMIT" = 1 ]; then
        if git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet && \
           [ -z "$(git -C "$ROOT" status --porcelain)" ]; then
            ok "没有变化，无需提交"
        else
            git -C "$ROOT" add -A -- config/pi/settings.json config/pi/mcp.json config/pi/AGENTS.md config/pi/extensions skills
            if git -C "$ROOT" diff --cached --quiet; then
                ok "托管配置没有变化，无需提交"
            else
                git -C "$ROOT" commit -q -m "chore: sync pi config from $HOST"
                ok "已提交: $(git -C "$ROOT" log --oneline -1)"
                info "推送: git -C $ROOT push"
            fi
        fi
    else
        info "确认无误后: bash sync.sh push --commit"
    fi
}

cmd_status() {
    printf '\n%s==> status%s  platform: %s\n' "$CYAN" "$NC" "$PLATFORM"
    printf '    repo: %s\n    pi:   %s\n    env:  %s\n\n' "$ROOT" "$DOT_PI" "$HOME/.pi-agent-env"
    info "托管文件"
    if [ ! -f "$DOT_PI/settings.json" ]; then
        printf '  %smissing%s  settings.json\n' "$YELLOW" "$NC"
    else
        python3 "$PY" merge-settings "$ROOT/config/pi/settings.json" "$DOT_PI/settings.json" "$LOCAL" "$TMP/s.json" >/dev/null
        if json_same "$DOT_PI/settings.json" "$TMP/s.json"; then
            printf '  %s=%s  settings.json\n' "$DIM" "$NC"
        else
            printf '  %sdiffers%s  settings.json（pull 会更新）\n' "$RED" "$NC"
        fi
    fi
    if [ ! -f "$DOT_PI/mcp.json" ]; then
        printf '  %smissing%s  mcp.json\n' "$YELLOW" "$NC"
    else
        python3 "$PY" merge-mcp "$ROOT/config/pi/mcp.json" "$ROOT/config/pi/platform/$PLATFORM/mcp.json" "$LOCAL/mcp.json" "$DOT_PI/mcp.json" "$TMP/m.json" >/dev/null
        if json_same "$DOT_PI/mcp.json" "$TMP/m.json"; then
            printf '  %s=%s  mcp.json\n' "$DIM" "$NC"
        else
            printf '  %sdiffers%s  mcp.json（pull 会更新）\n' "$RED" "$NC"
        fi
    fi
    if [ ! -e "$DOT_PI/AGENTS.md" ]; then
        printf '  %smissing%s  AGENTS.md\n' "$YELLOW" "$NC"
    elif [ -f "$COMMON_AGENTS" ]; then
        pi_agents_source "$TMP/AGENTS.md" >/dev/null || { fail "组合 $COMMON_AGENTS 与 $PI_AGENTS 失败"; return 1; }
        if cmp -s "$TMP/AGENTS.md" "$DOT_PI/AGENTS.md"; then printf '  %s=%s  AGENTS.md\n' "$DIM" "$NC"
        else printf '  %sdiffers%s  AGENTS.md（pull 会更新）\n' "$RED" "$NC"; fi
    elif cmp -s "$PI_AGENTS" "$DOT_PI/AGENTS.md"; then printf '  %s=%s  AGENTS.md\n' "$DIM" "$NC"
    else printf '  %sdiffers%s  AGENTS.md（pull 会更新）\n' "$RED" "$NC"; fi
    if [ ! -e "$HOME/.pi-agent-env" ]; then printf '  %smissing%s  ~/.pi-agent-env\n' "$YELLOW" "$NC"
    else printf '  %slocal%s  ~/.pi-agent-env（保留本机内容）\n' "$DIM" "$NC"; fi
    local ext name
    for ext in "$ROOT"/config/pi/extensions/*.ts; do
        name="$(basename "$ext")"
        ext_skipped "$name" && continue
        if [ ! -e "$DOT_PI/extensions/$name" ]; then printf '  %smissing%s  extensions/%s\n' "$YELLOW" "$NC" "$name"
        elif cmp -s "$ext" "$DOT_PI/extensions/$name"; then :; else printf '  %sdiffers%s  extensions/%s\n' "$RED" "$NC" "$name"; fi
    done
    if [ "${KITTO_SHARED_SKILLS_MANAGED:-0}" != 1 ] && [ "${KITTO_ALLOW_LEGACY_SKILL_SYNC:-0}" != 1 ]; then
        info "shared skills：由 Kitto JS 管理，直接 sync.sh 不比较/部署（KITTO_ALLOW_LEGACY_SKILL_SYNC=1 查看旧逻辑）"
    else
        local dir sname
        for dir in "$ROOT"/skills/*/; do
            sname="$(basename "$dir")"
            if [ ! -d "$DOT_AGENTS/skills/$sname" ]; then printf '  %smissing%s  skills/%s\n' "$YELLOW" "$NC" "$sname"
            elif diff -rq "$dir" "$DOT_AGENTS/skills/$sname" >/dev/null 2>&1; then :; else printf '  %sdiffers%s  skills/%s\n' "$RED" "$NC" "$sname"; fi
        done
    fi
    echo
    info "包"
    python3 - "$ROOT/config/pi/settings.json" "$DOT_PI/settings.json" "$LOCAL" <<'PY'
import json, os, sys
repo_path, mach_path, local = sys.argv[1:4]
def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return {}
def lst(p):
    if not os.path.exists(p): return []
    return [l.split("#",1)[0].strip() for l in open(p) if l.split("#",1)[0].strip()]
repo = load(repo_path).get("packages", [])
mach = load(mach_path).get("packages", [])
extra = set(lst(os.path.join(local, "packages.txt")))
skip = set(lst(os.path.join(local, "packages.skip.txt")))
for p in repo:
    mark = "skip" if p in skip else ("installed" if p in mach else "MISSING")
    print(f"  {mark:9} {p}" + ("  [machine skip]" if p in skip else ""))
for p in mach:
    if p not in repo and p not in extra:
        print(f"  {'local?':9} {p}  (不在仓库, 不在 local/packages.txt)")
for p in sorted(extra):
    print(f"  {'local':9} {p}  [config/pi/local/packages.txt]")
PY
    echo
    info "MCP"
    python3 - "$DOT_PI/mcp.json" <<'PY'
import json, sys
try:
    servers = json.load(open(sys.argv[1])).get("mcpServers", {})
except Exception:
    servers = {}
if not servers: print("  (无)")
for name, cfg in servers.items():
    state = "on " if cfg.get("enabled", True) else "off"
    src = "platform/local" if cfg.get("enabled") is False else "shared"
    print(f"  {state} {name:22} {src}")
PY
    echo
    info "git"
    git -C "$ROOT" status --short || true
    echo
}

cmd_deps() {
    if [ -f "$ROOT/config/dependencies.json" ]; then
        node --input-type=module - "$SCRIPT_ROOT/lib/dependencies.mjs" "$ROOT" "$DOT_PI" "$DRY" <<'JS'
import { pathToFileURL } from 'node:url';
const [module, source, piHome, dry] = process.argv.slice(2);
const { installDependencies } = await import(pathToFileURL(module));
await installDependencies({ source, piHome, agents: ['pi'] }, dry === '0');
JS
        return
    fi
    printf '\n%s==> deps%s  platform: %s\n\n' "$CYAN" "$NC" "$PLATFORM"
    if [ "$PLATFORM" = macos ] && command -v brew >/dev/null 2>&1; then
        info "Homebrew"
        while IFS= read -r pkg; do
            [ -z "$pkg" ] && continue
            brew list "$pkg" >/dev/null 2>&1 && { same "brew: $pkg"; continue; }
            info "brew install $pkg"
            run brew install "$pkg" || warn "brew $pkg 失败，继续"
        done < <(grep -v '^#' "$ROOT/lists/brew.txt" | sed 's/#.*//' | awk 'NF{print $1}')
    elif [ "$PLATFORM" = macos ]; then
        warn "Homebrew 未安装，跳过 lists/brew.txt"
    fi

    if command -v mise >/dev/null 2>&1; then
        info "mise npm 工具"
        local pkg ver
        while read -r pkg ver; do
            [ -z "${pkg:-}" ] && continue
            mise ls "npm:$pkg" --global --installed --no-header 2>/dev/null | awk -v v="$ver" '$2 == v { found=1 } END { exit !found }' && { same "mise: $pkg@$ver"; continue; }
            info "mise use -g npm:$pkg@$ver"
            run mise use -g "npm:$pkg@$ver" || warn "mise $pkg 失败，继续"
        done < <(grep -v '^#' "$ROOT/lists/mise-tools.txt" | awk 'NF==2{print $1, $2}')
        if [ -f "$ROOT/lists/npm.txt" ]; then
            info "npm CLI（mise 托管）"
            while read -r pkg ver; do
                [ -z "${pkg:-}" ] && continue
                mise ls "npm:$pkg" --global --installed --no-header 2>/dev/null | awk -v v="$ver" '$2 == v { found=1 } END { exit !found }' && { same "mise: $pkg@$ver"; continue; }
                info "mise use -g npm:$pkg@$ver"
                run mise use -g "npm:$pkg@$ver" || warn "mise $pkg 失败，继续"
            done < <(grep -v '^#' "$ROOT/lists/npm.txt" | awk 'NF==2{print $1, $2}')
        fi
    else
        warn "mise 未安装，跳过 CLI 工具（lists/mise-tools.txt, lists/npm.txt）"
    fi

    info "Python"
    local pipcmd=""
    command -v pip3 >/dev/null 2>&1 && pipcmd="pip3"
    python3 -m pip --version >/dev/null 2>&1 && pipcmd="python3 -m pip"
    if [ -n "$pipcmd" ]; then
        local pkg
        while IFS= read -r pkg; do
            [ -z "$pkg" ] && continue
            $pipcmd show "$pkg" >/dev/null 2>&1 && { same "pip: $pkg"; continue; }
            info "$pipcmd install $pkg"
            run $pipcmd install --quiet "$pkg" || warn "pip $pkg 失败，继续"
        done < <(grep -v '^#' "$ROOT/lists/pip.txt" | sed 's/#.*//' | awk 'NF{print $1}')
    else
        warn "没有可用的 pip，跳过 lists/pip.txt（Ubuntu: apt install python3-pip 或 uv）"
    fi
    echo
    ok "deps 结束（失败项只是 warning）"
}

case "$CMD" in
    pull)   cmd_pull ;;
    push)   cmd_push ;;
    status) cmd_status ;;
    deps)   cmd_deps ;;
    *)      fail "unknown command: $CMD"; sed -n '2,25p' "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# ============================================================
# pi-config sync — 仓库 <-> 本机 双向同步
#
#   bash sync.sh status           看仓库与本机差异（只读）
#   bash sync.sh pull             仓库 -> 本机（内容不同才覆盖；settings/mcp 走结构化合并）
#   bash sync.sh push             本机 -> 仓库（脱敏导出，运行时键与私钥不落盘）
#   bash sync.sh push --commit    导出并提交
#   bash sync.sh deps             按平台装 CLI 依赖（brew / mise / npm / pip）
#
# 机器专属配置放 config/pi/local/（gitignore），不会回流到仓库：
#   packages.txt       本机额外 pi 包
#   packages.skip.txt  不装的包（如与已有扩展工具名冲突）
#   settings.json      覆盖仓库 settings 的键
#   mcp.json           本机额外 / 覆盖的 MCP 服务器
# ============================================================
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${KITTO_CONFIG_ROOT:-$SCRIPT_ROOT}"
DOT_PI="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DOT_AGENTS="${PI_AGENTS_DIR:-$HOME/.agents}"
LOCAL="$ROOT/config/pi/local"
PY="$SCRIPT_ROOT/lib/pi_config.py"
HOST="$(hostname -s 2>/dev/null || hostname)"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'
YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
info() { printf '%s[info]%s %s\n' "$CYAN" "$NC" "$*"; }
ok()   { printf '%s[ok]%s   %s\n' "$GREEN" "$NC" "$*"; }
same() { printf '%s[=]%s    %s\n' "$DIM" "$NC" "$*"; }
warn() { printf '%s[skip]%s %s\n' "$YELLOW" "$NC" "$*"; }
fail() { printf '%s[fail]%s %s\n' "$RED" "$NC" "$*"; }

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
        --force|-f)   ;;            # 兼容 setup.sh 旧参数：pull 本就按内容覆盖
        -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
        *)            fail "unknown option: $arg"; exit 2 ;;
    esac
done

TMP="$(mktemp -d)"
LOCK=""
cleanup() {
    rm -rf "$TMP"
    [ -z "$LOCK" ] || rmdir "$LOCK"
}
trap cleanup EXIT
if [ "$DRY" = 0 ] && [[ "$CMD" =~ ^(pull|push|deps)$ ]]; then
    mkdir -p "$LOCAL"
    if ! mkdir "$LOCAL/.sync-lock" 2>/dev/null; then
        fail "另一个同步操作正在运行；若进程已退出，请检查后移除 $LOCAL/.sync-lock"
        exit 1
    fi
    LOCK="$LOCAL/.sync-lock"
fi

run() {
    if [ "$DRY" = 1 ]; then info "[dry-run] $*"; else "$@"; fi
}

in_list() { [ -f "$2" ] && grep -Fxq -- "$1" "$2"; }

json_same() { # <a> <b> -> 0 when both decode to the same JSON value
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

show_json_diff() { # <ref> <new> <label>
    if json_same "$1" "$2"; then
        same "$3（内容一致，仅格式差异）"
    else
        diff -u "$1" "$2" | sed -n '3,60p' | sed 's/^/    /' || true
    fi
}

# ---------------------------------------------------------------- deploys

deploy_file() { # <src> <dst> <label>
    local src="$1" dst="$2" label="${3:-$2}"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then same "$label"; return 0; fi
    if [ -f "$dst" ]; then info "update $label"; else info "create $label"; fi
    run mkdir -p "$(dirname "$dst")"
    run cp -f "$src" "$dst"
}

deploy_dir() { # <src dir> <dst dir> <label>
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

ext_skipped() { # <basename> -> 0 when this platform must not deploy it
    case "$PLATFORM:$1" in
        linux:herdr-agent-state.ts) return 0 ;;  # herdr 自己管理的集成文件
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------- steps

step_packages() {
    info "pi 扩展包"
    if ! command -v pi >/dev/null 2>&1; then
        warn "pi 未安装，跳过（先装 @earendil-works/pi-coding-agent）"
        return 0
    fi
    local installed pkg
    installed="$(pi list 2>/dev/null || true)"
    while IFS= read -r pkg; do
        [ -z "$pkg" ] && continue
        if in_list "$pkg" "$LOCAL/packages.skip.txt"; then
            warn "${pkg}（在 packages.skip.txt 里）"
            continue
        fi
        if grep -qF -- "$pkg" <<<"$installed"; then same "$pkg"; continue; fi
        info "pi install $pkg"
        run pi install "$pkg" || { fail "pi install $pkg 失败"; return 1; }
    done < <(python3 - "$ROOT/config/pi/settings.json" <<'PY'
import json, sys
for package in json.load(open(sys.argv[1]))['packages']:
    print(package if isinstance(package, str) else package['source'])
PY
)
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
    info "skills"
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
    local rc="$HOME/.zshrc"
    [ -f "$rc" ] || rc="$HOME/.bashrc"
    if [ -f "$rc" ] && ! grep -q 'pi-agent-env' "$rc"; then
        info "在 $(basename "$rc") 里加 source ~/.pi-agent-env"
        if [ "$DRY" = 1 ]; then
            info "[dry-run] append source line to $rc"
        else
            printf '\n# pi-config: MCP / provider tokens\n[ -f "$HOME/.pi-agent-env" ] && . "$HOME/.pi-agent-env"\n' >> "$rc"
        fi
    fi
}

# ---------------------------------------------------------------- commands

cmd_pull() {
    printf '\n%s==> pull%s  仓库 %s -> 本机 %s (platform: %s)\n\n' "$CYAN" "$NC" "$ROOT" "$DOT_PI" "$PLATFORM"
    run mkdir -p "$LOCAL" "$DOT_PI/extensions" "$DOT_AGENTS/skills"
    step_packages
    step_settings
    step_mcp
    deploy_file "$ROOT/config/pi/AGENTS.md" "$DOT_PI/AGENTS.md" "~/.pi/agent/AGENTS.md"
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
    info "settings.json（脱敏）"
    if [ "$DRY" = 1 ]; then
        python3 "$PY" sanitize-settings "$DOT_PI/settings.json" "$ROOT/config/pi/settings.json" "$LOCAL" "$TMP/settings.json"
        show_json_diff "$ROOT/config/pi/settings.json" "$TMP/settings.json" "config/pi/settings.json"
    else
        python3 "$PY" sanitize-settings "$DOT_PI/settings.json" "$ROOT/config/pi/settings.json" "$LOCAL" "$ROOT/config/pi/settings.json"
    fi
    deploy_file "$DOT_PI/AGENTS.md" "$ROOT/config/pi/AGENTS.md" "config/pi/AGENTS.md"
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
            git -C "$ROOT" add -u -- config/pi/settings.json config/pi/mcp.json config/pi/AGENTS.md config/pi/extensions skills
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
    # settings / mcp 不是字节比较：它们是合并出来的，比较"pull 是否会改变内容"
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
    local pair src dst label
    for pair in \
        "config/pi/AGENTS.md|$DOT_PI/AGENTS.md|AGENTS.md" \
        "config/env.example|$HOME/.pi-agent-env|~/.pi-agent-env"; do
        IFS='|' read -r src dst label <<<"$pair"
        if [ ! -e "$dst" ]; then printf '  %smissing%s  %s\n' "$YELLOW" "$NC" "$label"
        elif [ "$src" = config/env.example ]; then printf '  %slocal%s  %s（保留本机内容）\n' "$DIM" "$NC" "$label"
        elif cmp -s "$ROOT/$src" "$dst"; then printf '  %s=%s  %s\n' "$DIM" "$NC" "$label"
        else printf '  %sdiffers%s  %s\n' "$RED" "$NC" "$label"; fi
    done
    local ext name
    for ext in "$ROOT"/config/pi/extensions/*.ts; do
        name="$(basename "$ext")"
        ext_skipped "$name" && continue
        if [ ! -e "$DOT_PI/extensions/$name" ]; then printf '  %smissing%s  extensions/%s\n' "$YELLOW" "$NC" "$name"
        elif cmp -s "$ext" "$DOT_PI/extensions/$name"; then :; else printf '  %sdiffers%s  extensions/%s\n' "$RED" "$NC" "$name"; fi
    done
    local dir sname
    for dir in "$ROOT"/skills/*/; do
        sname="$(basename "$dir")"
        if [ ! -d "$DOT_AGENTS/skills/$sname" ]; then printf '  %smissing%s  skills/%s\n' "$YELLOW" "$NC" "$sname"
        elif diff -rq "$dir" "$DOT_AGENTS/skills/$sname" >/dev/null 2>&1; then :; else printf '  %sdiffers%s  skills/%s\n' "$RED" "$NC" "$sname"; fi
    done
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
    *)      fail "unknown command: $CMD"; sed -n '2,18p' "$0"; exit 2 ;;
esac

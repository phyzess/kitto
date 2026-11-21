#!/usr/bin/env python3
"""Structural helpers for the Pi adapter.

Each responsibility is a small subcommand so sync.sh can stay in bash:

  merge-settings   repo settings + machine settings + machine-only packages -> machine settings
  sanitize-settings machine settings -> repo settings (drops volatile keys)
  merge-mcp        repo + platform + machine local + machine -> machine mcp.json
  compose-agents   shared rules + host addendum -> deployed AGENTS.md
  extract-agents   deployed AGENTS.md -> host addendum only (never shared rules)

Shared definitions are updated while machine overrides and runtime switches
stay local. Preview helpers write only their explicit output path.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

VOLATILE_KEYS = ("lastChangelogVersion", "extensionChangelogVersions")

# Export must never turn a local secret into a repository commit. These are the
# key names and literal shapes that Kitto refuses to write into the source tree.
SECRET_KEY_NAMES = frozenset({
    "apikey", "api_key", "token", "access_token", "refresh_token", "secret",
    "client_secret", "password", "passwd", "private_key", "bearer_token", "authorization",
})
SECRET_VALUE_PATTERNS = (
    ("openai-style key", re.compile(r"sk-[A-Za-z0-9_-]{16,}")),
    ("GitHub token", re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}")),
    ("GitHub fine-grained token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("JWT", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)


def scan_secrets(value, path=""):
    """Return (cleaned, removed key paths, found literal secrets).

    Dict keys named like credentials are removed. Literal token shapes remain
    in place but are reported so the caller can refuse the export.
    """
    removed, found = [], []
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            child = f"{path}.{key}" if path else key
            if key.casefold() in SECRET_KEY_NAMES:
                removed.append(child)
                continue
            cleaned, child_removed, child_found = scan_secrets(item, child)
            out[key] = cleaned
            removed.extend(child_removed)
            found.extend(child_found)
        return out, removed, found
    if isinstance(value, list):
        cleaned = []
        for index, item in enumerate(value):
            child = f"{path}[{index}]"
            item, child_removed, child_found = scan_secrets(item, child)
            cleaned.append(item)
            removed.extend(child_removed)
            found.extend(child_found)
        return cleaned, removed, found
    if isinstance(value, str):
        for label, pattern in SECRET_VALUE_PATTERNS:
            if pattern.search(value):
                found.append((path, label))
    return value, removed, found


def refuse_secrets(found):
    if not found:
        return False
    for path, label in found:
        print(f"refusing to export a literal secret ({label}) at {path}", file=sys.stderr)
    print("Replace the literal with an environment-variable reference or remove it before exporting.", file=sys.stderr)
    return True


# ---------------------------------------------------------------- helpers


def load(path: str, default=None):
    if not path or not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError as exc:
            sys.exit(f"invalid JSON in {path}: {exc}")


def dump(path: str, data) -> bool:
    """Write JSON atomically. Returns True when the file changed."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    old = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            old = fh.read()
        if old == text:
            return False
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".kitto-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return True


def dump_semantic(path: str, data) -> bool:
    """Like dump(), but leaves the file byte-identical when the JSON means the
    same thing. Keeps the repo's own formatting until a real change lands."""
    if os.path.exists(path) and load(path) == data:
        return False
    return dump(path, data)


def read_text(path: str) -> str | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write_text(path: str, text: str) -> bool:
    """Write UTF-8 text atomically. Returns True when the file changed."""
    old = read_text(path)
    if old == text:
        return False
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".kitto-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return True


def compose_agents(common: str | None, addendum: str | None) -> str:
    """Shared rules first, then the host addendum.

    Byte-identical to composeInstructions() in lib/host-config.mjs. Stripping
    each section keeps the result stable no matter how the files end.
    """
    sections = [text.strip() for text in (common, addendum) if text and text.strip()]
    return "\n\n".join(sections) + "\n" if sections else ""


def read_list(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            value = raw.strip()
            if value.startswith("#"):
                continue
            if value:
                out.append(value)
    return out


def write_list(path: str, values: list[str]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    body = "\n".join(values)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"# generated by sync.sh pull — machine-only pi packages\n{body}\n" if body else
                 "# generated by sync.sh pull — machine-only pi packages\n")


def deep_merge(base, over):
    """Dicts merge recursively, everything else is replaced by `over`."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for key, value in over.items():
            out[key] = deep_merge(out[key], value) if key in out else value
        return out
    return over


def unique(seq):
    seen = set()
    out = []
    for item in seq:
        key = json.dumps(item, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


# ---------------------------------------------------------------- commands


def package_key(package):
    source = package if isinstance(package, str) else package.get("source", "")
    if source.startswith("npm:"):
        spec = source.removeprefix("npm:")
        if spec.rfind("@") > 0:
            source = "npm:" + spec.rsplit("@", 1)[0]
    elif source.startswith(("git:github.com/", "https://github.com/")):
        repo = source.split("github.com/", 1)[1].split("@", 1)[0].removesuffix(".git")
        source = "github.com/" + repo
    return source


def cmd_list_shared_packages(argv: list[str]) -> int:
    repo_path, skip_path = argv
    skip = {package_key(item) for item in read_list(skip_path)}
    for package in load(repo_path)["packages"]:
        if package_key(package) not in skip:
            print(package if isinstance(package, str) else package["source"])
    return 0


def cmd_merge_settings(argv: list[str]) -> int:
    repo_path, machine_path, local_dir, out_path = argv
    repo_cfg = load(repo_path, {}) or {}
    machine_cfg = load(machine_path, {}) or {}
    for key in VOLATILE_KEYS:
        repo_cfg.pop(key, None)

    extra_path = os.path.join(local_dir, "packages.txt")
    skip = {package_key(item) for item in read_list(os.path.join(local_dir, "packages.skip.txt"))}

    extra = read_list(extra_path)
    previous = load(os.path.join(local_dir, "managed-packages.json"), []) or []
    # Unknown packages remain local. Previously managed entries can be removed
    # by deleting them from the shared source. No source mutation during preview.
    repo_pkgs = repo_cfg.get("packages", [])
    extra = unique(extra + [p for p in machine_cfg.get("packages", [])
                            if p not in repo_pkgs and p not in previous])

    overrides = load(os.path.join(local_dir, "settings.json"), {}) or {}

    # Start from what the machine already has (keeps runtime keys), let the repo
    # own the keys it declares, then apply this machine's overrides.
    result = dict(machine_cfg)
    for key, value in repo_cfg.items():
        result[key] = value
    result = deep_merge(result, overrides)

    before = list(machine_cfg.get("packages", []))
    packages = unique(
        [p for p in (repo_pkgs + extra)
         if package_key(p) not in skip]
    )
    result["packages"] = packages

    changed = dump(out_path, result)
    added = [p for p in packages if p not in before]
    removed = [p for p in before if p not in packages]
    print(f"settings: {'updated' if changed else 'unchanged'}")
    if added:
        print("  packages added: " + ", ".join(map(str, added)))
    if removed:
        print("  packages dropped: " + ", ".join(map(str, removed)))
    if extra:
        print("  machine-only packages kept: " + ", ".join(map(str, extra)))
    return 0


def cmd_record_settings(argv: list[str]) -> int:
    """Record ownership only after a successful real settings deployment."""
    repo_path, machine_path, local_dir = argv
    repo = load(repo_path, {}).get("packages", [])
    machine = load(machine_path, {}).get("packages", [])
    extra_path = os.path.join(local_dir, "packages.txt")
    extra = unique(read_list(extra_path) + [p for p in machine if p not in repo])
    # Pi object-form package entries are preserved in settings but not flattened
    # into a text list. The ownership record still supports them.
    write_list(extra_path, [p for p in extra if isinstance(p, str)])
    dump(os.path.join(local_dir, "managed-packages.json"), repo)
    return 0


def restore_overrides(out, repo, overrides):
    """Remove machine-owned values from export, restoring shared defaults."""
    result = dict(out)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = restore_overrides(result[key], repo.get(key, {})
                                           if isinstance(repo.get(key), dict) else {}, value)
            if not result[key] and key not in repo:
                result.pop(key)
        elif key in repo:
            result[key] = repo[key]
        else:
            result.pop(key, None)
    return result


def cmd_sanitize_settings(argv: list[str]) -> int:
    machine_path, repo_path, local_dir, out_path = argv
    machine = load(machine_path, {}) or {}
    repo = load(repo_path, {}) or {}
    extra = read_list(os.path.join(local_dir, "packages.txt"))
    skip = read_list(os.path.join(local_dir, "packages.skip.txt"))

    # Repo owns the key order so pushes stay diff-quiet; machine values win so
    # local edits (theme, defaults, …) still travel upstream.
    repo_pkgs = list(repo.get("packages", []))
    mach_pkgs = list(machine.get("packages", []))
    dropped = [p for p in mach_pkgs if p in extra or p in skip]
    additions = [p for p in mach_pkgs if p not in repo_pkgs and p not in extra and p not in skip]
    packages = unique(repo_pkgs + additions)

    out: dict = {}
    for key in repo:
        if key in VOLATILE_KEYS:
            continue
        out[key] = packages if key == "packages" else machine.get(key, repo[key])
    if "packages" not in out:
        out["packages"] = packages

    overrides = load(os.path.join(local_dir, "settings.json"), {}) or {}
    out = restore_overrides(out, repo, overrides)
    out, removed, found = scan_secrets(out)
    if refuse_secrets(found):
        return 1
    if removed:
        print("  credential-shaped keys left out: " + ", ".join(sorted(removed)))
    changed = dump_semantic(out_path, out)
    print(f"settings: {'exported' if changed else 'unchanged'}")
    if dropped:
        print("  machine-only packages left out: " + ", ".join(map(str, dropped)))
    if additions:
        print("  new packages taken upstream: " + ", ".join(map(str, additions)))
    return 0


def cmd_merge_mcp(argv: list[str]) -> int:
    repo_path, platform_path, local_path, machine_path, out_path = argv
    sources = [("machine", machine_path), ("repo", repo_path),
               ("platform", platform_path), ("local", local_path)]
    merged: dict[str, dict] = {}
    for _, path in sources:
        cfg = load(path, {}) or {}
        for name, entry in (cfg.get("mcpServers") or {}).items():
            if name.startswith("_") or not isinstance(entry, dict):
                continue
            merged[name] = deep_merge(merged.get(name, {}), entry)
    machine = load(machine_path, {}) or {}
    local = (load(local_path, {}) or {}).get("mcpServers", {})
    for name, entry in machine.get("mcpServers", {}).items():
        if name not in merged or not isinstance(entry, dict):
            continue
        for key in ("enabled", "exposure", "toolExposure"):
            if key in entry and key not in local.get(name, {}):
                merged[name][key] = entry[key]
    changed = dump(out_path, {**machine, "mcpServers": merged})
    enabled = [n for n, e in merged.items() if e.get("enabled", True)]
    disabled = [n for n, e in merged.items() if not e.get("enabled", True)]
    print(f"mcp: {'updated' if changed else 'unchanged'} ({len(merged)} servers)")
    if enabled:
        print("  enabled: " + ", ".join(enabled))
    if disabled:
        print("  disabled: " + ", ".join(disabled))
    return 0


def cmd_export_mcp(argv: list[str]) -> int:
    repo_path, machine_path, platform_path, local_path, private_path, out_path = argv
    repo = (load(repo_path, {}) or {}).get("mcpServers") or {}
    machine = (load(machine_path, {}) or {}).get("mcpServers") or {}
    platform = (load(platform_path, {}) or {}).get("mcpServers") or {}
    local = (load(local_path, {}) or {}).get("mcpServers") or {}
    private = (load(private_path, {}) or {}).get("mcpServers") or {}

    out: dict[str, dict] = {}
    replaced: list[str] = []
    dropped: list[str] = []
    for name, entry in machine.items():
        if name in local or name in private:
            if name in repo:
                out[name] = repo[name]
            dropped.append(name)
            continue
        if name in platform:
            if name in repo:
                out[name] = repo[name]      # platform override is machine-specific
                replaced.append(name)
            else:
                dropped.append(name)        # platform-only server never ships
            continue
        if name in repo:
            out[name] = entry
        else:
            dropped.append(name)            # unmanaged server never ships

    out, removed, found = scan_secrets(out)
    if refuse_secrets(found):
        return 1
    if removed:
        print("  credential-shaped keys left out: " + ", ".join(sorted(removed)))
    changed = dump_semantic(out_path, {"mcpServers": out})
    print(f"mcp: {'exported' if changed else 'unchanged'} ({len(out)} servers)")
    if dropped:
        print("  left out (unmanaged/local/platform/private): " + ", ".join(sorted(dropped)))
    if replaced:
        print("  repo entry kept instead of machine override: " + ", ".join(sorted(replaced)))
    return 0


def cmd_compose_agents(argv: list[str]) -> int:
    common_path, addendum_path, out_path = argv
    common = read_text(common_path)
    if common is None:
        print(f"missing shared instructions: {common_path}", file=sys.stderr)
        return 1
    write_text(out_path, compose_agents(common, read_text(addendum_path)))
    return 0


def cmd_extract_agents(argv: list[str]) -> int:
    """Export only the host addendum, so shared rules never travel upstream."""
    machine_path, common_path, out_path = argv
    machine, common = read_text(machine_path), read_text(common_path)
    if machine is None:
        print(f"missing deployed instructions: {machine_path}", file=sys.stderr)
        return 1
    if common is None:
        print(f"missing shared instructions: {common_path}", file=sys.stderr)
        return 1
    prefix, body = common.strip(), machine.strip()
    if not prefix or not body.startswith(prefix):
        print(f"{machine_path} does not start with {common_path}; push only exports the host-specific "
              "section. Edit shared rules in the source and run sync again before exporting.", file=sys.stderr)
        return 1
    addendum = body[len(prefix):].strip()
    if not addendum:
        print(f"{machine_path} has no host-specific section; refusing to export an empty addendum.", file=sys.stderr)
        return 1
    changed = write_text(out_path, addendum + "\n")
    print(f"AGENTS.md: {'exported' if changed else 'unchanged'} (host addendum only)")
    return 0


COMMANDS = {
    "list-shared-packages": cmd_list_shared_packages,
    "record-settings": cmd_record_settings,
    "merge-settings": cmd_merge_settings,
    "sanitize-settings": cmd_sanitize_settings,
    "merge-mcp": cmd_merge_mcp,
    "export-mcp": cmd_export_mcp,
    "compose-agents": cmd_compose_agents,
    "extract-agents": cmd_extract_agents,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in COMMANDS:
        sys.exit("usage: pi_config.py "
                 "{merge-settings|sanitize-settings|merge-mcp|export-mcp|compose-agents|extract-agents} ...")
    return COMMANDS[argv[1]](argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))

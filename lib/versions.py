#!/usr/bin/env python3
"""Read-only component inventory for Kitto maintenance operations.

No installation, cache writes, MCP startup or channel selection occurs here.
Network metadata is fetched only with --online; each request has a timeout.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.parse
import urllib.request

ROOT = Path(os.environ.get('KITTO_CONFIG_ROOT', Path(__file__).resolve().parents[1]))
HOSTS = {'pi': '@earendil-works/pi-coding-agent', 'codex': '@openai/codex', 'dsh': '@deepseek-ai/dsh', 'pnpm': 'pnpm'}


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return {}


def command(args):
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=8)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def npm_spec(spec):
    """Split scoped names and optional versions without interpreting Git refs."""
    spec = spec.removeprefix('npm:')
    split = spec.rfind('@')
    if split > 0:
        return spec[:split], spec[split + 1:]
    return spec, None


def declared_tools(root):
    out = []
    for name in ('mise-tools.txt', 'npm.txt'):
        path = root / 'lists' / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            parts = line.split('#', 1)[0].split()
            if len(parts) == 2:
                out.append({'name': parts[0], 'target': parts[1], 'kind': 'npm', 'owner': 'mise'})
    return out


def tree_hash(path):
    digest = hashlib.sha256()
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            continue
        if file.is_file() and '__pycache__' not in file.parts:
            digest.update(file.relative_to(path).as_posix().encode() + b'\0')
            digest.update(file.read_bytes())
    return digest.hexdigest()


def inventory(root=ROOT, agent_dir=None):
    agent_dir = Path(agent_dir or os.environ.get('PI_CODING_AGENT_DIR', Path.home() / '.pi/agent'))
    rows = []
    kitto_manifest = Path(__file__).resolve().parents[1] / 'package.json'
    if kitto_manifest.exists():
        package = read_json(kitto_manifest)
        rows.append({'name': package['name'], 'kind': 'npm', 'owner': 'kitto',
                     'installed': package['version'], 'target': None, 'path': str(kitto_manifest)})
    for executable, package in HOSTS.items():
        path = shutil.which(executable)
        output = command([path, '--version']) if path else None
        match = re.search(r'\d+\.\d+\.\d+(?:-[\w.-]+)?', output or '')
        rows.append({'name': package, 'kind': 'npm', 'owner': 'dsh-prerequisite' if executable == 'pnpm' else 'host', 'path': path,
                     'installed': match.group() if match else None, 'target': None})
    settings = read_json(root / 'config/pi/settings.json')
    for entry in settings.get('packages', []):
        source = entry if isinstance(entry, str) else entry['source']
        if source.startswith('npm:'):
            name, target = npm_spec(source)
            manifest = agent_dir / 'npm/node_modules' / name / 'package.json'
            rows.append({'name': name, 'kind': 'npm', 'owner': 'pi', 'target': target,
                         'installed': read_json(manifest).get('version'), 'path': str(manifest)})
        else:
            rows.append({'name': source, 'kind': 'git', 'owner': 'pi', 'installed': None,
                         'note': 'Resolve installed checkout with the native package manager.'})
    rows += declared_tools(root)
    for row in rows:
        if row['owner'] == 'mise':
            output = command(['mise', 'ls', 'npm:' + row['name'], '--global', '--installed', '--json'])
            try:
                data = json.loads(output or '[]')
                if isinstance(data, dict):
                    data = next(iter(data.values()), [])
                row['installed'] = [item['version'] for item in data]
            except (ValueError, KeyError, TypeError):
                row['installed'] = None
    servers = read_json(root / 'config/pi/mcp.json').get('mcpServers', {})
    for name, server in servers.items():
        if server.get('command') == 'npx':
            args = [s for s in server.get('args', []) if not s.startswith('-')]
            if not args:
                continue
            package, target = npm_spec(args[0])
            declared = next((r for r in rows if r['name'] == package and r['owner'] == 'mise'), None)
            rows.append({'name': package, 'kind': 'npm', 'owner': 'npx', 'target': target,
                         'installed': None, 'mcp': name,
                         'versionConflict': bool(declared and target != declared['target']),
                         'note': 'npx runtime version is not inferred from a global installation.'})
        elif server.get('command') not in ('dap-mcp-server',):
            rows.append({'name': name, 'kind': 'external', 'owner': 'external', 'installed': None,
                         'note': 'Resolve actual binary and installation source before updating.'})
    for name in ('debugpy', 'serena-agent'):
        output = command(['python3', '-m', 'pip', 'show', name])
        match = re.search(r'^Version: (.+)$', output or '', re.M)
        rows.append({'name': name, 'kind': 'pypi', 'owner': 'python',
                     'installed': match.group(1) if match else None,
                     'note': 'Only current Python environment; uv environments need separate inspection.'})
    revision = command(['git', '-C', str(root), 'rev-parse', 'HEAD'])
    for path in sorted((root / 'skills').iterdir()):
        if (path / 'SKILL.md').is_file() and not path.is_symlink():
            rows.append({'name': path.name, 'kind': 'skill', 'owner': 'config',
                         'revision': revision, 'contentSha256': tree_hash(path)})
    for path in sorted((root / 'config/pi/extensions').glob('*.ts')):
        rows.append({'name': path.name, 'kind': 'extension', 'owner': 'config',
                     'revision': revision, 'contentSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return rows


def upstream(kind, name):
    encoded = urllib.parse.quote(name, safe='')
    url = ('https://registry.npmjs.org/' + encoded if kind == 'npm'
           else 'https://pypi.org/pypi/' + encoded + '/json')
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.load(response)
        if kind == 'npm':
            tags = {k: v for k, v in data.get('dist-tags', {}).items()
                    if k in ('latest', 'next', 'alpha', 'beta', 'canary')}
            versions = data.get('versions', {})
            return {'source': url, 'channels': tags,
                    'requirements': {tag: {'engines': versions.get(v, {}).get('engines', {}),
                                          'peers': versions.get(v, {}).get('peerDependencies', {}),
                                          'deprecated': versions.get(v, {}).get('deprecated')}
                                     for tag, v in tags.items()}}
        return {'source': url, 'version': data['info']['version'],
                'requiresPython': data['info']['requires_python']}
    except Exception as exc:
        return {'source': url, 'error': str(exc)}


def report(online=False, root=ROOT):
    rows = inventory(root)
    if online:
        keys = sorted({(r['kind'], r['name']) for r in rows if r['kind'] in ('npm', 'pypi')})
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = dict(zip(keys, pool.map(lambda pair: upstream(*pair), keys)))
        for row in rows:
            if (row['kind'], row['name']) in results:
                row['upstream'] = results[(row['kind'], row['name'])]
    return {'checkedAt': datetime.now(timezone.utc).isoformat(), 'online': online, 'components': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--online', action='store_true', help='query registries without updating packages')
    args = parser.parse_args()
    print(json.dumps(report(args.online), ensure_ascii=False, indent=2))

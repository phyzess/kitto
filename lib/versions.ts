import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dependencyPlan, executable, npmSpec, npxPackage, optionalJson, piServers, query } from './dependencies.ts';
import { isDesktopProfile } from './dsh-profile.ts';
import { hostSkillRoots } from './host-config.ts';

import { readVersion } from './version-order.ts';

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function resources(root, revision, hashTree) {
  const rows = [];
  for (const entry of await entries(root)) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || !(await entries(path)).some(file => file.name === 'SKILL.md' && file.isFile())) continue;
    rows.push({ kind: 'skill', name: entry.name, revision, contentSha256: await hashTree(path, true) });
  }
  return rows;
}

async function piVersions(state, revision) {
  const rows = [];
  const settings = await optionalJson(join(state.source, 'config/pi/settings.json'));
  const machine = await optionalJson(join(state.piHome, 'settings.json'), settings);
  const specs = new Map();
  for (const list of [settings.packages || [], machine.packages || []]) {
    for (const entry of list) {
      const source = typeof entry === 'string' ? entry : entry.source;
      if (source?.startsWith('npm:')) {
        const [name, target] = npmSpec(source);
        specs.set(name, target);
      } else if (source) {
        if (!rows.some(row => row.name === source)) rows.push({ name: source, kind: 'source', installed: null });
      }
    }
  }
  for (const [name, target] of specs) {
    const manifest = await optionalJson(join(state.piHome, 'npm/node_modules', name, 'package.json'));
    rows.push({ kind: 'npm', name, target, installed: manifest.version || null });
  }
  for (const [id, server] of Object.entries(await piServers(state))) {
    const [name, target] = npxPackage(server);
    if (name) rows.push({ kind: 'npm', name, target, installed: null, mcp: id, note: 'Version resolved by npx at launch.' });
    else rows.push({ kind: 'external', name: server.command, mcp: id, path: executable(server.command) || null });
  }
  const extensions = join(state.source, 'config/pi/extensions');
  for (const file of await entries(extensions)) {
    if (!file.isFile() || !file.name.endsWith('.ts')) continue;
    rows.push({ kind: 'extension', name: file.name, revision, contentSha256: createHash('sha256').update(await readFile(join(extensions, file.name))).digest('hex') });
  }
  return rows.map(row => ({ ...row, owner: 'pi' }));
}

async function codexVersions(state) {
  const output = query('codex', ['plugin', 'list', '--json'], { ...process.env, CODEX_HOME: state.codexHome });
  if (!output) return [{ kind: 'inventory', owner: 'codex', note: 'Native plugin inventory unavailable.' }];
  try {
    return JSON.parse(output).installed.map(plugin => ({
      kind: 'plugin', owner: 'codex', name: plugin.pluginId, installed: plugin.version || null, enabled: plugin.enabled,
    }));
  } catch {
    return [{ kind: 'inventory', owner: 'codex', note: 'Unrecognized native plugin inventory.' }];
  }
}

async function dshVersions(state) {
  const profile = state.dshProfile || 'web';
  const root = join(state.dshHome, 'profiles', profile);
  const manifest = await optionalJson(join(root, 'package.json'));
  const rows = [];
  for (const name of manifest.dsh?.profile?.bundles || []) {
    const target = manifest.dependencies?.[name];
    const bundled = !target;
    const installed = bundled ? {} : await optionalJson(join(root, 'node_modules', name, 'package.json'));
    rows.push({ kind: bundled ? 'bundle' : 'npm', owner: 'dsh', profile,
      name, target: target || null, installed: installed.version || (name === '@phyzess/kitto' ? state.version : null),
      note: bundled ? 'Bundled with DSH.' : undefined });
  }
  return rows;
}

async function upstream(kind, name) {
  const encoded = encodeURIComponent(name);
  const url = kind === 'npm' ? `https://registry.npmjs.org/${encoded}` : `https://pypi.org/pypi/${encoded}/json`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (kind === 'pypi') return { source: url, version: data.info.version, requiresPython: data.info.requires_python };
    const channels = Object.fromEntries(Object.entries(data['dist-tags'] || {}).filter(
      ([tag]) => ['latest', 'next', 'alpha', 'beta', 'canary'].includes(tag),
    ));
    const requirements = Object.fromEntries(Object.entries(channels).map(([tag, value]) => {
      const release = data.versions?.[value];
      return [tag, { engines: release?.engines, peers: release?.peerDependencies, deprecated: release?.deprecated }];
    }));
    return { source: url, channels, requirements };
  } catch (error) {
    return { source: url, error: error.message };
  }
}

export async function versionReport(state, hosts, pnpmVersion, online, hashTree) {
  const rows = [{ kind: 'npm', owner: 'kitto', name: '@phyzess/kitto', installed: state.version }];
  for (const name of state.agents) {
    rows.push({ kind: 'npm', owner: name, name: hosts[name].package, installed: readVersion(query(name, ['--version'])), tested: hosts[name].version });
  }
  if (state.agents.includes('dsh') && !isDesktopProfile(state.dshProfile)) rows.push({ kind: 'npm', owner: 'dsh', name: 'pnpm', installed: readVersion(query('pnpm', ['--version'])), tested: pnpmVersion });
  const revision = query('git', ['-C', state.source, 'rev-parse', 'HEAD']);
  if (state.agents.includes('pi')) rows.push(...await piVersions(state, revision));
  if (state.agents.includes('codex')) rows.push(...await codexVersions(state));
  if (state.agents.includes('dsh')) {
    if (isDesktopProfile(state.dshProfile)) {
      rows.push({ kind: 'inventory', owner: 'dsh', profile: state.dshProfile,
        note: 'DSH desktop profile is app-managed; Kitto does not manage its bundles, patch or pnpm.' });
    } else rows.push(...await dshVersions(state));
  }
  for (const { name, source } of [{ name: 'shared', source: join(state.source, 'skills') }, ...hostSkillRoots(state)]) {
    rows.push(...(await resources(source, revision, hashTree)).map(row => ({ ...row, owner: name })));
  }
  for (const tool of await dependencyPlan(state)) {
    const kind = { mise: 'npm', pip: 'pypi', brew: 'brew' }[tool.manager] || 'external';
    rows.push({ ...tool, kind });
  }
  if (online) {
    const groups = new Map();
    for (const row of rows.filter(row => ['npm', 'pypi'].includes(row.kind))) {
      const key = `${row.kind}:${row.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const batches = [...groups.values()];
    for (let i = 0; i < batches.length; i += 6) {
      await Promise.all(batches.slice(i, i + 6).map(async group => {
        const result = await upstream(group[0].kind, group[0].name);
        for (const row of group) row.upstream = result;
      }));
    }
  }
  return { checkedAt: new Date().toISOString(), online, components: rows };
}

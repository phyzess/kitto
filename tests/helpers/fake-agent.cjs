// Stateful native-manager fixture; never contacts a network or runs a model.
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
const versions = { pi: '1.5.2', codex: '0.169.0', dsh: '0.2.2-rc.3', pnpm: '12.18.0' };
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: name, args }) + '\n');
if (args.includes('--version')) { console.log(versions[name]); process.exit(); }
if (args.includes('--help')) process.exit();
if (process.env.FAIL_HOST === name && args.includes(process.env.FAIL_ACTION || 'add') &&
    (!process.env.FAIL_STAGE || args.includes(process.env.FAIL_STAGE))) process.exit(9);
function load(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback; }
function save(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }
if (name === 'pi') {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), data = load(file, {});
  if (args[0] === 'install') {
    data.packages ||= [];
    const source = path.relative(path.dirname(file), args[1]);
    if (!data.packages.includes(source)) data.packages.push(source);
    save(file, data);
  } else if (args[0] === 'remove') {
    data.packages = (data.packages || []).filter(source => path.resolve(path.dirname(file), typeof source === 'string' ? source : source.source) !== args[1]);
    save(file, data);
  }
} else if (name === 'codex') {
  const file = path.join(process.env.CODEX_HOME, '_fake-codex.json');
  const data = load(file, { marketplaces: [], installed: [] });
  const market = args[1] === 'marketplace', action = args[market ? 2 : 1], value = args[market ? 3 : 2];
  if (action === 'list') console.log(JSON.stringify(market ? { marketplaces: data.marketplaces } : { installed: data.installed, available: [] }));
  else {
    if (market && action === 'add') data.marketplaces = [...data.marketplaces.filter(x => x.name !== 'phyzess-kitto'), { name: 'phyzess-kitto', root: value }];
    if (!market && action === 'add') data.installed = [...data.installed.filter(x => x.pluginId !== value), {
      pluginId: value, marketplaceName: 'phyzess-kitto', source: { source: 'local', path: path.join(process.env.KITTO_HOME, 'runtime/integration') },
    }];
    if (market && action === 'remove') data.marketplaces = data.marketplaces.filter(x => x.name !== value);
    if (!market && action === 'remove') data.installed = data.installed.filter(x => x.pluginId !== value);
    save(file, data);
  }
} else if (name === 'dsh') {
  const file = path.join(process.env.DSH_HOME, 'profiles/web/package.json');
  const data = load(file, { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  if (args[3] === 'add') {
    data.dependencies['@phyzess/kitto'] = `link:${args[4]}`;
    if (!data.dsh.profile.bundles.includes('@phyzess/kitto')) data.dsh.profile.bundles.push('@phyzess/kitto');
  } else if (args[3] === 'remove') {
    delete data.dependencies['@phyzess/kitto'];
    data.dsh.profile.bundles = data.dsh.profile.bundles.filter(x => x !== '@phyzess/kitto');
  }
  save(file, data);
}

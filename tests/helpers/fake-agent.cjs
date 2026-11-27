const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]),
  args = process.argv.slice(2);
const { hosts, pnpmVersion } = require('../../lib/host-pins.ts');
const versions = {
  pi: hosts.pi.version,
  codex: hosts.codex.version,
  dsh: hosts.dsh.version,
  pnpm: pnpmVersion,
  codegraph: '1.6.4',
  ...JSON.parse(process.env.FAKE_HOST_VERSIONS || '{}'),
};
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: name, args }) + '\n');
if (args.includes('--version')) {
  console.log(versions[name]);
  process.exit();
}
if (args.includes('--help')) process.exit(process.env.FAKE_HOST_NO_HELP === name ? 1 : 0);
if (
  process.env.FAIL_HOST === name &&
  args.includes(process.env.FAIL_ACTION || 'add') &&
  (!process.env.FAIL_STAGE || args.includes(process.env.FAIL_STAGE))
)
  process.exit(9);
function load(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback;
}
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
if (name === 'pi') {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'),
    data = load(file, {});
  if (args[0] === 'install') {
    data.packages ||= [];
    const source = path.relative(path.dirname(file), args[1]);
    if (!data.packages.includes(source)) data.packages.push(source);
    save(file, data);
  } else if (args[0] === 'remove') {
    data.packages = (data.packages || []).filter(
      (source) => path.resolve(path.dirname(file), typeof source === 'string' ? source : source.source) !== args[1],
    );
    save(file, data);
  }
} else if (name === 'codex') {
  const file = process.env.FAKE_CODEX_STATE || path.join(process.env.CODEX_HOME, '_fake-codex.json');
  const data = load(file, { marketplaces: [], installed: [] });
  data.marketplaces ||= [];
  data.installed ||= [];
  if (args[0] === 'mcp') {
    data.mcpServers ||= {};
    const serializeTransport = (entry) =>
      entry.transport.type === 'stdio'
        ? {
            type: 'stdio',
            command: entry.transport.command,
            args: entry.transport.args || [],
            env: entry.transport.env ?? null,
            env_vars: entry.transport.env_vars ?? [],
            cwd: entry.transport.cwd ?? null,
          }
        : {
            type: 'streamable_http',
            url: entry.transport.url,
            bearer_token_env_var: entry.transport.bearer_token_env_var ?? null,
            http_headers: entry.transport.http_headers ?? null,
            env_http_headers: entry.transport.env_http_headers ?? null,
            http_headers_helper: entry.transport.http_headers_helper ?? null,
          };
    const serialize = (serverName, entry, list) => {
      const transport = serializeTransport(entry),
        enabled = entry.enabled !== false;
      const base = { name: serverName, enabled, disabled_reason: null, transport };
      if (list) {
        return {
          ...base,
          startup_timeout_sec: entry.startup_timeout_sec ?? null,
          tool_timeout_sec: entry.tool_timeout_sec ?? null,
          auth_status: 'unsupported',
        };
      }
      return {
        ...base,
        enabled_tools: entry.enabled_tools ?? null,
        disabled_tools: entry.disabled_tools ?? null,
        startup_timeout_sec: entry.startup_timeout_sec ?? null,
        tool_timeout_sec: entry.tool_timeout_sec ?? null,
      };
    };
    const action = args[1];
    if (action === 'list') {
      const rows = Object.entries(data.mcpServers).map(([serverName, entry]) => serialize(serverName, entry, true));
      if (args.includes('--json')) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(row.name);
      process.exit();
    }
    if (action === 'get') {
      const serverName = args[2];
      if (!data.mcpServers[serverName]) {
        console.error(`No MCP server named '${serverName}' found.`);
        process.exit(1);
      }
      const row = serialize(serverName, data.mcpServers[serverName], false);
      console.log(args.includes('--json') ? JSON.stringify(row) : `${row.name}\n  enabled: ${row.enabled}`);
      process.exit();
    }
    if (action === 'add') {
      const rest = args.slice(2),
        serverName = rest.shift();
      if (process.env.FAKE_MCP_FAIL_ADD === serverName) {
        console.error('simulated MCP add failure');
        process.exit(9);
      }
      let url = null,
        bearer = null,
        command = [],
        env = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--') {
          command = rest.slice(i + 1);
          break;
        }
        if (rest[i] === '--url') url = rest[++i];
        else if (rest[i] === '--env') {
          const pair = rest[++i] ?? '',
            split = pair.indexOf('=');
          env[pair.slice(0, split)] = pair.slice(split + 1);
        } else if (rest[i] === '--bearer-token-env-var') bearer = rest[++i];
      }
      data.mcpServers[serverName] = url
        ? { transport: { type: 'streamable_http', url, ...(bearer ? { bearer_token_env_var: bearer } : {}) } }
        : { transport: { type: 'stdio', command: command[0] ?? '', args: command.slice(1), ...(Object.keys(env).length ? { env } : {}) } };
      save(file, data);
      console.log(`Added global MCP server '${serverName}'.`);
      process.exit();
    }
    if (action === 'remove') {
      const serverName = args[2];
      if (process.env.FAKE_MCP_FAIL_REMOVE === serverName) {
        console.error('simulated MCP remove failure');
        process.exit(9);
      }
      if (data.mcpServers[serverName]) {
        delete data.mcpServers[serverName];
        save(file, data);
      } else console.log(`No MCP server named '${serverName}' found.`);
      process.exit();
    }
    console.error(`Unknown fake mcp command: ${args.join(' ')}`);
    process.exit(2);
  }
  const market = args[1] === 'marketplace',
    action = args[market ? 2 : 1],
    value = args[market ? 3 : 2];
  if (action === 'list')
    console.log(JSON.stringify(market ? { marketplaces: data.marketplaces } : { installed: data.installed, available: [] }));
  else {
    if (market && action === 'add')
      data.marketplaces = [...data.marketplaces.filter((x) => x.name !== 'phyzess-kitto'), { name: 'phyzess-kitto', root: value }];
    if (!market && action === 'add')
      data.installed = [
        ...data.installed.filter((x) => x.pluginId !== value),
        {
          pluginId: value,
          marketplaceName: 'phyzess-kitto',
          source: { source: 'local', path: path.join(process.env.KITTO_HOME, 'runtime/integration') },
        },
      ];
    if (market && action === 'remove') data.marketplaces = data.marketplaces.filter((x) => x.name !== value);
    if (!market && action === 'remove') data.installed = data.installed.filter((x) => x.pluginId !== value);
    save(file, data);
  }
} else if (name === 'dsh') {
  if (args[0] === 'plugin' && args[1] === '--profile' && args[2] === 'desktop' && args[3] === 'version-exemptions') {
    const delay = Number(process.env.FAKE_DSH_PROBE_DELAY_MS || 0);
    if (delay) {
      const until = Date.now() + delay;
      while (Date.now() < until) {}
    }
    if (process.env.FAKE_DSH_CLI === 'npm') {
      console.error('error: profile "desktop" is managed exclusively by the Electron application');
      process.exit(1);
    }
    const manifest = path.join(process.env.DSH_HOME, 'profiles/desktop/package.json');
    if (!fs.existsSync(manifest)) {
      console.error(
        'dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.',
      );
      process.exit(1);
    }
    console.log('[]');
    process.exit();
  }
  const file = path.join(process.env.DSH_HOME, 'profiles', args[2], 'package.json');
  const data = load(file, { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  if (args[3] === 'add') {
    data.dependencies['@phyzess/kitto'] = `link:${args[4]}`;
    if (!data.dsh.profile.bundles.includes('@phyzess/kitto')) data.dsh.profile.bundles.push('@phyzess/kitto');
  } else if (args[3] === 'remove') {
    delete data.dependencies['@phyzess/kitto'];
    data.dsh.profile.bundles = data.dsh.profile.bundles.filter((x) => x !== '@phyzess/kitto');
  }
  save(file, data);
}

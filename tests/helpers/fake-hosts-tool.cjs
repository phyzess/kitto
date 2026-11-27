const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]),
  args = process.argv.slice(2);
const versionsFile = process.env.HOSTS_VERSIONS;
const logFile = process.env.HOSTS_LOG;
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(versionsFile, 'utf8'));
  } catch {
    return {};
  }
};
const save = (data) => fs.writeFileSync(versionsFile, JSON.stringify(data));
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ command: name, args }) + '\n');

const packages = { pi: '@earendil-works/pi-coding-agent', codex: '@openai/codex', dsh: '@deepseek-ai/dsh' };
if (name === 'npm') {
  if (args.includes('--version')) {
    console.log('11.20.0');
    process.exit(0);
  }
  if (process.env.HOSTS_NPM_FAIL === '1') {
    console.error('simulated npm failure');
    process.exit(9);
  }
  let spec = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--global' && args[i - 1] === 'install') spec = args[i + 1];
  if (!spec) {
    console.error(`fake npm: unsupported ${args.join(' ')}`);
    process.exit(2);
  }
  const split = spec.lastIndexOf('@');
  const pkg = spec.slice(0, split),
    version = spec.slice(split + 1);
  if (process.env.HOSTS_NPM_PERMISSION === '1') {
    console.error('npm ERR! code EACCES');
    console.error('npm ERR! syscall mkdir');
    console.error('npm ERR! path /usr/local/lib/node_modules');
    process.exit(243);
  }
  if (process.env.HOSTS_NPM_FAIL_PACKAGE === pkg) {
    console.error(`simulated npm failure for ${pkg}`);
    process.exit(9);
  }
  const data = read();
  if (process.env.HOSTS_NPM_NOOP !== '1') save({ ...data, installed: { ...(data.installed || {}), [pkg]: version } });
  process.exit(0);
}

if (args.includes('--version')) {
  const data = read();
  const version = data.installed?.[packages[name]] ?? data[name];
  if (version === undefined || version === null) {
    console.error(`${name}: command not found`);
    process.exit(127);
  }
  console.log(`${name} ${version}`);
  process.exit(0);
}
console.error(`fake ${name}: unsupported ${args.join(' ')}`);
process.exit(2);

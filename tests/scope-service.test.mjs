import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  configureServiceScope, readServiceEnvironment, readServiceProperties, servicePnpmAvailable, stageServicePackage,
} from '../lib/scope-service.mjs';

const valid = {
  Id: 'dsh.service',
  LoadState: 'loaded',
  ActiveState: 'active',
  MainPID: '3100',
  User: 'dsh',
  DynamicUser: 'no',
  RootDirectory: '',
  RootImage: '',
};
const output = properties => Object.entries(properties).map(([key, value]) => key + '=' + value).join('\n') + '\n';

test('only an active named system service can supply a setup account', async () => {
  for (const unit of ['dsh.socket', '/tmp/dsh.service', '--help.service', 'dsh*.service', 'dsh.service\nother.service']) {
    await assert.rejects(configureServiceScope({ unit, root: '/workspace', dryRun: true }), /service unit name/);
    await assert.rejects(servicePnpmAvailable(unit), /service unit name/);
  }
  assert.deepEqual(readServiceProperties('dsh.service', output(valid)), { pid: '3100', user: 'dsh' });
  for (const properties of [
    { Id: 'alias.service' }, { LoadState: 'masked' }, { ActiveState: 'inactive' }, { MainPID: '0' }, { MainPID: '../1' },
  ]) assert.throws(() => readServiceProperties('dsh.service', output({ ...valid, ...properties })), /loaded and active/);
  for (const properties of [
    { User: '' }, { User: '-system' }, { User: 'root' }, { User: '0' },
    { DynamicUser: 'yes' }, { RootDirectory: '/srv/isolated' }, { RootImage: '/srv/dsh.img' },
  ]) assert.throws(() => readServiceProperties('dsh.service', output({ ...valid, ...properties })), /fixed non-root account/);
});

test('delegation copies only validated service path variables', () => {
  const env = [
    'HOME=/srv/dsh', 'PATH=/srv/dsh/bin:/usr/bin', 'DSH_HOME=/srv/dsh/.dsh',
    'KITTO_HOME=/srv/kitto', 'DSH_AGENTS_HOME=/srv/dsh/agents', 'XDG_DATA_HOME=/srv/dsh/share', 'NODE_OPTIONS=--require /somewhere',
    'DSH_API_TOKEN=never-copy-this', 'USER=unexpected', '',
  ].join('\0');
  assert.deepEqual(readServiceEnvironment(env), {
    HOME: '/srv/dsh', DSH_HOME: '/srv/dsh/.dsh', KITTO_HOME: '/srv/kitto',
    DSH_AGENTS_HOME: '/srv/dsh/agents', XDG_DATA_HOME: '/srv/dsh/share', PATH: '/srv/dsh/bin:/usr/bin',
  });
  assert.throws(() => readServiceEnvironment('PATH=/bin\0'), /must provide HOME and PATH/);
  assert.throws(() => readServiceEnvironment(env + 'HOME=/another\0'), /Duplicate service environment variable: HOME/);
  for (const path of [':/bin', '/bin:relative', '/bin:/with\nnewline']) {
    assert.throws(() => readServiceEnvironment('HOME=/srv/dsh\0PATH=' + path + '\0'), /PATH must contain absolute paths/);
  }
  assert.throws(() => readServiceEnvironment('HOME=/srv/dsh\0PATH=/bin\0DSH_HOME=relative\0'), /DSH_HOME must contain absolute paths/);
});

test('guided service staging includes legacy runtime assets and excludes the personal source', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'kitto-service-stage-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, 'source');
  const stage = join(fixture, 'stage');
  const packaged = [
    'package.json', 'sync.sh', 'CHANGELOG.md', 'bin/kitto.mjs', 'bin/maintain.mjs',
    'lib/scopes.mjs', 'lib/pi_config.py', 'integration/scoped-dsh/index.mjs',
    'integration/cordis.patch.yml', 'integration/skills/kitto/SKILL.md',
  ];
  for (const file of [...packaged, 'config/pi/mcp.private.json', '.git/config', 'skills/private/SKILL.md', '.env']) {
    const path = join(source, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file);
  }
  await mkdir(stage);
  await stageServicePackage(source, stage, true);
  for (const file of packaged) assert.equal(await readFile(join(stage, file), 'utf8'), file);
  assert.deepEqual((await readdir(stage)).sort(), ['CHANGELOG.md', 'bin', 'integration', 'lib', 'package.json', 'sync.sh']);
});

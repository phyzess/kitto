import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import kittoScopes from '../integration/scoped-pi/index.mjs';
import { installPiScope } from '../lib/scope-pi.mjs';

async function fixture(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'kitto-pi-scope-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Pi extension install is idempotent and protects a foreign target', async t => {
  const root = await fixture(t);
  const runtime = join(root, 'scope-runtime');
  const agent = join(root, 'custom-pi');
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });

  const path = join(agent, 'extensions', 'kitto-scopes.js');
  const adapter = join(runtime, 'integration/scoped-pi/index.mjs');
  const options = { home: root, runtime };
  assert.deepEqual(await installPiScope({ ...options, dryRun: true }), { path, changed: true });
  await assert.rejects(readlink(path), { code: 'ENOENT' });
  assert.deepEqual(await installPiScope(options), { path, changed: true });
  assert.equal(await readlink(path), adapter);
  assert.deepEqual(await installPiScope({ ...options, dryRun: true }), { path, changed: false });
  assert.deepEqual(await installPiScope(options), { path, changed: false });

  await rm(path);
  await writeFile(path, 'user extension');
  await assert.rejects(installPiScope(options), /path is already occupied/);
  assert.equal(await readFile(path, 'utf8'), 'user extension');
  await rm(path);
  const foreign = join(root, 'dangling');
  await symlink(foreign, path);
  await assert.rejects(installPiScope({ ...options, dryRun: true }), /path is already occupied/);
  assert.equal(await readlink(path), foreign);
});

test('Pi loads registered scope skills and augments native context without duplicating it', async t => {
  const root = await fixture(t);
  const store = join(root, 'store');
  const old = process.env.KITTO_HOME;
  process.env.KITTO_HOME = store;
  t.after(() => {
    if (old === undefined) delete process.env.KITTO_HOME;
    else process.env.KITTO_HOME = old;
  });
  const global = join(store, 'global');
  const workspace = join(root, 'work');
  const project = join(workspace, 'project');
  const cwd = join(project, 'child');
  const skills = dir => join(dir, '.agents', 'skills');
  const instructions = dir => join(dir, 'AGENTS.md');
  const globalInstructions = instructions(global);
  const workspaceInstructions = instructions(workspace);
  const projectInstructions = instructions(project);
  const childInstructions = instructions(cwd);
  for (const directory of [global, workspace, project]) await mkdir(skills(directory), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(store, 'scopes.json'), JSON.stringify({ version: 1, global: true, workspaces: [project, workspace] }));
  await writeFile(globalInstructions, 'global rules');
  await writeFile(workspaceInstructions, '\uFEFFworkspace rules');
  await writeFile(projectInstructions, 'project rules');
  await writeFile(childInstructions, 'child rules');

  const handlers = new Map();
  kittoScopes({ on: (event, handler) => handlers.set(event, handler) });
  const discover = handlers.get('resources_discover');
  assert.deepEqual(await discover({ cwd }), { skillPaths: [skills(project), skills(workspace), skills(global)] });
  assert.deepEqual(await discover({ cwd: root }), { skillPaths: [skills(global)] });

  const settingsDir = join(root, '.pi', 'agent');
  const nativeGlobal = instructions(settingsDir);
  await mkdir(dirname(nativeGlobal), { recursive: true });
  await symlink(globalInstructions, nativeGlobal);
  const nativeFiles = [
    { path: nativeGlobal, content: 'global rules' },
    { path: projectInstructions, content: 'project rules' },
    { path: childInstructions, content: 'child rules' },
  ];
  const prompt = handlers.get('before_agent_start');
  const files = [...nativeFiles];
  await prompt({ systemPromptOptions: { contextFiles: files } }, { cwd });
  assert.deepEqual(files, [nativeFiles[0], { path: workspaceInstructions, content: 'workspace rules' }, ...nativeFiles.slice(1)]);
});

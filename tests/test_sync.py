"""Regression tests run only against disposable repositories and homes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pi_config', ROOT / 'lib/pi_config.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kitto-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo with ' quote"
        shutil.copytree(ROOT, self.repo, ignore=shutil.ignore_patterns('.git', '__pycache__', 'local'))
        self.home = self.base / 'home'
        self.home.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.fake('brew', 'exit 1')
        self.fake('pi', 'if [ "$1" = list ]; then exit 0; fi\nexit 0')
        self.env = {**os.environ, 'HOME': str(self.home),
                    'PI_CODING_AGENT_DIR': str(self.home / '.pi/agent'),
                    'PI_AGENTS_DIR': str(self.home / '.agents'),
                    'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}
        self.local = self.repo / 'config/pi/local'
        self.machine = self.home / '.pi/agent/settings.json'
        self.shared = self.repo / 'config/pi/settings.json'

    def fake(self, name, body):
        path = self.bin / name
        path.write_text('#!/usr/bin/env bash\n' + body + '\n')
        path.chmod(0o755)

    def put(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
        return path

    def get(self, path):
        return json.loads(path.read_text())

    def run_sync(self, *args, check=True):
        result = subprocess.run(['bash', str(self.repo / 'sync.sh'), *args],
                                env=self.env, text=True, errors="replace", capture_output=True)
        if check and result.returncode:
            self.fail(result.stdout + result.stderr)
        return result

    def merge(self):
        helper.cmd_merge_settings(list(map(str, [self.shared, self.machine, self.local, self.machine])))
        helper.cmd_record_settings(list(map(str, [self.shared, self.machine, self.local])))

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() if p.is_file() else None
                for p in self.base.rglob('*') if not p.is_symlink()}

    def test_preview_and_status_do_not_write(self):
        self.put(self.machine, {'packages': ['npm:personal']})
        before = self.snapshot()
        self.run_sync('status')
        self.run_sync('pull', '--dry-run')
        self.assertEqual(before, self.snapshot())

    def test_clean_home_preview_does_not_create_destinations(self):
        before = self.snapshot()
        self.run_sync('pull', '--dry-run')
        self.assertEqual(before, self.snapshot())

    def test_removed_shared_package_stays_removed_local_survives(self):
        self.put(self.shared, {'packages': ['npm:shared']})
        self.put(self.machine, {'packages': ['npm:shared', 'npm:personal']})
        self.merge()
        self.put(self.shared, {'packages': []})
        self.merge()
        self.assertEqual(self.get(self.machine)['packages'], ['npm:personal'])
        self.merge()
        self.assertEqual(self.get(self.machine)['packages'], ['npm:personal'])

    def test_new_machine_package_is_preserved(self):
        self.put(self.shared, {'packages': []})
        self.put(self.machine, {'packages': []})
        self.merge()
        self.put(self.machine, {'packages': ['npm:later']})
        self.merge()
        self.assertEqual(self.get(self.machine)['packages'], ['npm:later'])

    def test_git_fragment_survives_local_list(self):
        self.local.mkdir(parents=True)
        path = self.local / 'packages.txt'
        path.write_text('# comment\ngit:example/repo#v1.2.3\n')
        self.assertEqual(helper.read_list(str(path)), ['git:example/repo#v1.2.3'])

    def test_nested_local_overrides_do_not_export(self):
        self.put(self.shared, {'defaultModel': 'shared', 'nested': {'a': 1, 'b': 2}})
        self.put(self.local / 'settings.json', {'defaultModel': 'local', 'nested': {'a': 99}, 'secret': 'x'})
        self.put(self.machine, {'defaultModel': 'local', 'nested': {'a': 99, 'b': 3}, 'secret': 'x', 'lastChangelogVersion': 'runtime'})
        out = self.base / 'export.json'
        helper.cmd_sanitize_settings(list(map(str, [self.machine, self.shared, self.local, out])))
        result = self.get(out)
        self.assertEqual(result['defaultModel'], 'shared')
        self.assertEqual(result['nested'], {'a': 1, 'b': 3})
        self.assertNotIn('secret', result)
        self.assertNotIn('lastChangelogVersion', result)

    def test_mcp_definition_updates_switch_and_unknown_server_survive(self):
        repo = self.put(self.base / 'repo.json', {'mcpServers': {'x': {'command': 'new', 'args': ['new']}}})
        machine = self.put(self.base / 'machine.json', {'other': True, 'mcpServers': {'x': {'command': 'old', 'args': ['old'], 'enabled': False}, 'personal': {'command': 'mine'}}})
        out = self.base / 'out.json'
        helper.cmd_merge_mcp([str(repo), '', '', str(machine), str(out)])
        data = self.get(out)
        self.assertEqual(data['mcpServers']['x'], {'command': 'new', 'args': ['new'], 'enabled': False})
        self.assertIn('personal', data['mcpServers'])
        self.assertTrue(data['other'])

    def test_mcp_local_override_is_explicit(self):
        repo = self.put(self.base / 'repo.json', {'mcpServers': {'x': {'command': 'new'}}})
        machine = self.put(self.base / 'machine.json', {'mcpServers': {'x': {'enabled': False}}})
        local = self.put(self.base / 'local.json', {'mcpServers': {'x': {'enabled': True}}})
        out = self.base / 'out.json'
        helper.cmd_merge_mcp([str(repo), '', str(local), str(machine), str(out)])
        self.assertTrue(self.get(out)['mcpServers']['x']['enabled'])

    def test_export_preserves_shared_server_with_local_override(self):
        repo = self.put(self.base / 'repo.json', {'mcpServers': {'x': {'command': 'shared'}}})
        local = self.put(self.base / 'local.json', {'mcpServers': {'x': {'command': 'local'}}})
        out = self.base / 'out.json'
        helper.cmd_export_mcp([str(repo), str(local), '', str(local), '', str(out)])
        self.assertEqual(self.get(out), self.get(repo))

    def test_export_does_not_add_unmanaged_mcp_or_settings(self):
        repo = self.put(self.base / 'repo.json', {'mcpServers': {'shared': {'command': 'shared'}}})
        machine = self.put(self.base / 'machine.json', {
            'theme': 'light',
            'mcpServers': {
                'shared': {'command': 'shared'},
                'personal': {'command': 'npx', 'args': ['--token', 'sk-this-should-not-travel']},
            },
        })
        out = self.base / 'export.json'
        helper.cmd_export_mcp([str(repo), str(machine), '', '', '', str(out)])
        self.assertEqual(self.get(out), {'mcpServers': {'shared': {'command': 'shared'}}})
        settings = self.put(self.base / 'settings.json', {'packages': [], 'theme': 'dark'})
        machine_settings = self.put(self.base / 'machine-settings.json', {
            'packages': [], 'theme': 'light', 'apiKey': 'sk-this-should-not-travel',
        })
        exported = self.base / 'settings-export.json'
        helper.cmd_sanitize_settings([str(machine_settings), str(settings), str(self.local), str(exported)])
        data = self.get(exported)
        self.assertNotIn('apiKey', data)
        self.assertEqual(data['theme'], 'light')

    def test_export_refuses_literal_secret_in_declared_entry(self):
        repo = self.put(self.base / 'repo.json', {'mcpServers': {'bad': {'command': 'x', 'args': ['sk-this-should-not-travel']}}})
        out = self.base / 'export.json'
        self.assertEqual(helper.cmd_export_mcp([str(repo), str(repo), '', '', '', str(out)]), 1)

    def test_env_preserved_and_pull_idempotent(self):
        token = self.home / '.pi-agent-env'
        token.write_text('SYNTHETIC_TOKEN=keep-me\n')
        self.run_sync('pull')
        before = self.snapshot()
        self.run_sync('pull')
        self.assertEqual(token.read_text(), 'SYNTHETIC_TOKEN=keep-me\n')
        self.assertEqual(before, self.snapshot())

    def test_new_env_private_permissions(self):
        self.run_sync('pull')
        self.assertEqual((self.home / '.pi-agent-env').stat().st_mode & 0o777, 0o600)

    def test_push_ignores_unmanaged_skills_and_extensions(self):
        self.run_sync('pull')
        skill = self.home / '.agents/skills/third-party/SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('third-party')
        ext = self.home / '.pi/agent/extensions/third-party.ts'
        ext.write_text('third-party')
        self.run_sync('push')
        self.assertFalse((self.repo / 'skills/third-party').exists())
        self.assertFalse((self.repo / 'config/pi/extensions/third-party.ts').exists())

    def test_lock_blocks_mutation(self):
        lock = self.local / '.sync-lock'
        lock.mkdir(parents=True)
        result = self.run_sync('pull', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(lock.exists())
        self.assertFalse(self.machine.exists())

    def test_failed_package_install_stops_deploy(self):
        self.fake('pi', 'if [ "$1" = list ]; then exit 0; fi\nexit 7')
        result = self.run_sync('pull', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.machine.exists())
        self.assertFalse((self.local / '.sync-lock').exists())

    def init_git(self):
        def git(*args):
            return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                                  text=True, capture_output=True)
        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        git('add', '.')
        git('commit', '-m', 'fixture')
        return git

    def test_commit_does_not_include_unrelated_work(self):
        git = self.init_git()
        self.run_sync('pull')
        settings = self.get(self.machine)
        settings['theme'] = 'light'
        self.put(self.machine, settings)
        (self.repo / 'README.md').write_text('unrelated edit')
        (self.repo / 'unrelated.txt').write_text('untracked')
        self.run_sync('push', '--commit')
        paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout
        self.assertIn('config/pi/settings.json', paths)
        self.assertNotIn('README.md', paths)
        self.assertNotIn('unrelated.txt', paths)
        self.assertIn('README.md', git('status', '--short').stdout)

    def test_commit_refuses_existing_staged_changes(self):
        git = self.init_git()
        self.run_sync('pull')
        (self.repo / 'README.md').write_text('staged work')
        git('add', 'README.md')
        before = git('rev-parse', 'HEAD').stdout
        result = self.run_sync('push', '--commit', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, git('rev-parse', 'HEAD').stdout)
        self.assertEqual(git('diff', '--cached', '--name-only').stdout.strip(), 'README.md')

    def test_local_package_skip_survives_version_pinning(self):
        self.local.mkdir(parents=True, exist_ok=True)
        (self.local / 'packages.skip.txt').write_text('npm:@plannotator/pi-extension\nhttps://github.com/ayghri/i-have-adhd\n')
        result = self.run_sync('pull')
        self.assertNotIn('pi install npm:@plannotator/pi-extension', result.stdout)
        self.assertNotIn('pi install git:github.com/ayghri/i-have-adhd', result.stdout)
        packages = json.loads(self.machine.read_text())['packages']
        self.assertFalse(any('plannotator' in entry or 'i-have-adhd' in entry for entry in packages))

    def test_mise_installed_wrong_version_does_not_skip(self):
        self.fake('mise', 'if [ "$1" = ls ]; then echo "npm:dap-mcp-server 0.0.1"; fi\nexit 0')
        result = self.run_sync('deps', '--dry-run')
        self.assertIn('mise use -g npm:dap-mcp-server@0.1.17', result.stdout)


if __name__ == '__main__':
    unittest.main()

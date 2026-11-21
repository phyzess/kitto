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
        self.env = {**{key: value for key, value in os.environ.items()
                       if not key.startswith('KITTO_')},
                    'HOME': str(self.home),
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

    def run_sync(self, *args, check=True, env=None):
        result = subprocess.run(['bash', str(self.repo / 'sync.sh'), *args],
                                env=env or self.env, text=True, errors="replace", capture_output=True)
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

    def test_environment_has_no_inherited_kitto_toggles(self):
        self.assertEqual([key for key in self.env if key.startswith('KITTO_')], [])

    def test_direct_entry_warns_but_internal_sync_does_not(self):
        direct = self.run_sync('status')
        self.assertIn('deprecated direct entry; use kitto setup/sync', direct.stdout)
        internal = self.run_sync('status', env={**self.env, 'KITTO_SHARED_SKILLS_MANAGED': '1'})
        self.assertNotIn('deprecated direct entry', internal.stdout)

    def test_direct_status_does_not_report_skipped_shared_skills(self):
        result = self.run_sync('status')
        self.assertIn('由 Kitto JS 管理', result.stdout)
        self.assertNotIn('missing  skills/', result.stdout)
        self.assertNotIn('differs  skills/', result.stdout)

    def test_direct_pull_does_not_deploy_shared_skills(self):
        result = self.run_sync('pull')
        self.assertIn('由 Kitto JS 管理', result.stdout)
        self.assertIn('KITTO_ALLOW_LEGACY_SKILL_SYNC=1', result.stdout)
        self.assertFalse((self.home / '.agents/skills').exists())
        self.assertTrue(self.machine.exists(), 'Pi settings should still deploy')

    def test_pi_agents_compose_shared_rules_before_the_pi_addendum(self):
        self.run_sync('pull')
        common = (self.repo / 'config/instructions/common.md').read_text().strip()
        addendum = (self.repo / 'config/pi/AGENTS.md').read_text().strip()
        text = (self.home / '.pi/agent/AGENTS.md').read_text()
        self.assertTrue(text.startswith(common))
        self.assertEqual(text.count(common), 1)
        self.assertIn(addendum, text)
        self.assertEqual(text.count('## Pi 专属补充'), 1)
        repo_addendum = (self.repo / 'config/pi/AGENTS.md').read_text()
        self.assertNotIn('# 共享工作规则', repo_addendum)
        self.assertTrue(repo_addendum.startswith('## Pi 专属补充'))

    def test_pi_push_exports_only_the_pi_addendum(self):
        self.run_sync('pull')
        machine = self.home / '.pi/agent/AGENTS.md'
        machine.write_text(machine.read_text().replace('## Pi 专属补充', '## Pi 专属补充（本机修改）'))
        self.run_sync('push')
        exported = (self.repo / 'config/pi/AGENTS.md').read_text()
        self.assertIn('（本机修改）', exported)
        self.assertNotIn('# 共享工作规则', exported)

    def test_pi_push_preview_does_not_write_shared_rules_back(self):
        self.run_sync('pull')
        machine = self.home / '.pi/agent/AGENTS.md'
        machine.write_text(machine.read_text().replace('## Pi 专属补充', '## Pi 专属补充（预览）'))
        before = self.snapshot()
        result = self.run_sync('push', '--dry-run')
        self.assertIn('[dry-run] cp -f', result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_pi_push_refuses_agents_without_the_shared_prefix(self):
        self.run_sync('pull')
        machine = self.home / '.pi/agent/AGENTS.md'
        machine.write_text('# legacy whole-file AGENTS\n')
        before = (self.repo / 'config/pi/AGENTS.md').read_text()
        result = self.run_sync('push', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('host-specific section', result.stderr)
        self.assertEqual((self.repo / 'config/pi/AGENTS.md').read_text(), before)

    def test_legacy_whole_file_pi_agents_is_replaced_without_duplication(self):
        path = self.home / '.pi/agent/AGENTS.md'
        path.parent.mkdir(parents=True)
        path.write_text('# Pi Agent — 全局适配\n\n- old whole-file rule\n')
        self.run_sync('pull')
        text = path.read_text()
        self.assertEqual(text.count('# 共享工作规则'), 1)
        self.assertIn('## Pi 专属补充', text)
        self.assertNotIn('old whole-file rule', text)

    def test_shared_rule_change_flows_into_the_pi_agents_file(self):
        self.run_sync('pull')
        common = self.repo / 'config/instructions/common.md'
        common.write_text(common.read_text() + '\n- new shared rule marker\n')
        self.run_sync('pull')
        text = (self.home / '.pi/agent/AGENTS.md').read_text()
        self.assertEqual(text.count('new shared rule marker'), 1)
        self.assertIn('## Pi 专属补充', text)

    def test_config_without_shared_layer_keeps_the_legacy_whole_file_deploy(self):
        (self.repo / 'config/instructions/common.md').unlink()
        self.run_sync('pull')
        expected = (self.repo / 'config/pi/AGENTS.md').read_text()
        self.assertEqual((self.home / '.pi/agent/AGENTS.md').read_text(), expected)
        self.run_sync('push')
        self.assertEqual((self.repo / 'config/pi/AGENTS.md').read_text(), expected)

    def test_compose_and_extract_agents_helpers(self):
        common = self.base / 'common.md'
        addendum = self.base / 'addendum.md'
        out = self.base / 'out.md'
        common.write_text('# Shared\n\n- one\n')
        addendum.write_text('## Host\n\n- two\n')
        self.assertEqual(helper.cmd_compose_agents([str(common), str(addendum), str(out)]), 0)
        self.assertEqual(out.read_text(), '# Shared\n\n- one\n\n## Host\n\n- two\n')
        extracted = self.base / 'extracted.md'
        self.assertEqual(helper.cmd_extract_agents([str(out), str(common), str(extracted)]), 0)
        self.assertEqual(extracted.read_text(), '## Host\n\n- two\n')
        out.write_text('# not composed\n')
        self.assertEqual(helper.cmd_extract_agents([str(out), str(common), str(extracted)]), 1)
        self.assertEqual(extracted.read_text(), '## Host\n\n- two\n')
        out.write_text('# Shared\n')
        self.assertEqual(helper.cmd_extract_agents([str(out), str(common), str(extracted)]), 1)

    def test_legacy_skill_sync_requires_explicit_opt_in(self):
        env = {**self.env, 'KITTO_ALLOW_LEGACY_SKILL_SYNC': '1'}
        result = self.run_sync('pull', env=env)
        self.assertIn('legacy direct-sync', result.stdout)
        self.assertTrue((self.home / '.agents/skills/hindsight/SKILL.md').is_file())

    def test_direct_pull_legacy_opt_in_still_previews_without_writes(self):
        env = {**self.env, 'KITTO_ALLOW_LEGACY_SKILL_SYNC': '1'}
        before = self.snapshot()
        self.run_sync('pull', '--dry-run', env=env)
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

    def test_commit_includes_new_managed_files(self):
        git = self.init_git()
        self.run_sync('pull')
        (self.repo / 'config/pi/extensions/new.ts').write_text('export const value = 1;\n')
        (self.repo / 'skills/new').mkdir(parents=True)
        (self.repo / 'skills/new/SKILL.md').write_text(
            '---\nname: new\ndescription: New skill.\n---\n')
        self.run_sync('push', '--commit')
        paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout
        self.assertIn('config/pi/extensions/new.ts', paths)
        self.assertIn('skills/new/SKILL.md', paths)

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

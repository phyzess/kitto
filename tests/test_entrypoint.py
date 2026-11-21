"""Shell entrypoint tests: setup.sh only delegates to `kitto setup`."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SetupEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kitto-entry-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.record = self.base / 'node-args.txt'
        fake = self.bin / 'node'
        fake.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$KITTO_TEST_NODE_ARGS"\nexit 0\n')
        fake.chmod(0o755)
        self.env = {
            **os.environ,
            'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'KITTO_TEST_NODE_ARGS': str(self.record),
            'KITTO_HOME': str(self.base / 'kitto-home'),
        }

    def run_setup(self, *args):
        return subprocess.run(['bash', str(ROOT / 'setup.sh'), *args], env=self.env,
                              stdin=subprocess.DEVNULL, text=True, capture_output=True)

    def node_args(self):
        if not self.record.exists():
            return None
        args = self.record.read_text().splitlines()
        self.assertTrue(args and args[0].endswith('bin/kitto.mjs'), args)
        return args[1:]

    def test_help_exits_without_node(self):
        result = self.run_setup('--help')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('kitto setup', result.stdout)
        self.assertIsNone(self.node_args())

    def test_force_warns_once_and_maps_to_plain_setup(self):
        result = self.run_setup('--force', '-f', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr.count('已废弃'), 1, result.stderr)
        self.assertEqual(self.node_args(), ['setup', '--dry-run'])

    def test_force_alone_maps_to_setup_without_force(self):
        result = self.run_setup('--force')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup'])

    def test_no_args_non_tty_delegates_to_setup_instead_of_sync(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup'])
        self.assertNotIn('pi-config setup', result.stdout + result.stderr)
        self.assertNotIn('sync.sh', result.stdout + result.stderr)

    def test_interactive_is_passed_through(self):
        result = self.run_setup('--interactive')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup', '--interactive'])

    def test_dry_run_and_options_are_passed_through(self):
        result = self.run_setup('--dry-run', '--agents', 'pi,codex')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup', '--dry-run', '--agents', 'pi,codex'])


if __name__ == '__main__':
    unittest.main()

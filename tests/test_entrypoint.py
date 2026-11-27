"""Shell entrypoint tests: setup.sh only delegates to `kitto setup`."""
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

FAKE_NODE = '''#!/usr/bin/env bash
{
    printf 'arg=%s\\n' "$@"
    printf 'stdin_tty=%s\\n' "$([ -t 0 ] && echo 1 || echo 0)"
} > "$KITTO_TEST_NODE_ARGS"
if [ -n "${KITTO_TEST_NODE_EXIT:-}" ]; then
    exit "$KITTO_TEST_NODE_EXIT"
fi
exit 0
'''


class SetupEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kitto-entry-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.record = self.base / 'node-args.txt'
        fake = self.bin / 'node'
        fake.write_text(FAKE_NODE)
        fake.chmod(0o755)
        inherited = {key: value for key, value in os.environ.items()
                     if not key.startswith('KITTO_')}
        self.env = {
            **inherited,
            'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'KITTO_TEST_NODE_ARGS': str(self.record),
            'KITTO_HOME': str(self.base / 'kitto-home'),
        }

    def run_setup(self, *args, env=None):
        return subprocess.run(['bash', str(ROOT / 'setup.sh'), *args], env=env or self.env,
                              stdin=subprocess.DEVNULL, text=True, capture_output=True)

    def node_call(self):
        lines = self.record.read_text().splitlines()
        self.assertTrue(lines, 'fake node was not called')
        self.assertTrue(lines[-1].startswith('stdin_tty='), lines)
        stdin_tty = lines[-1] == 'stdin_tty=1'
        args = [line[len('arg='):] for line in lines[:-1]]
        self.assertTrue(args and args[0].endswith('dist/bin/kitto.mjs'), args)
        return args[1:], stdin_tty

    def node_args(self):
        return self.node_call()[0]

    def test_help_exits_without_node(self):
        result = self.run_setup('--help')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('kitto setup', result.stdout)
        self.assertFalse(self.record.exists(), '--help must not start node')

    def test_force_warns_once_and_maps_to_plain_setup(self):
        result = self.run_setup('--force', '-f', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr.count('已废弃'), 1, result.stderr)
        self.assertEqual(self.node_args(), ['setup', '--dry-run'])

    def test_force_alone_maps_to_setup_without_force(self):
        result = self.run_setup('--force')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        args, stdin_tty = self.node_call()
        self.assertEqual(args, ['setup'])
        self.assertFalse(stdin_tty, '--force must not expose a TTY to the wizard')

    def test_force_drops_interactive_flag(self):
        result = self.run_setup('--interactive', '--force')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup'])

    def test_exit_code_is_propagated(self):
        result = self.run_setup('--force', '--dry-run',
                                env={**self.env, 'KITTO_TEST_NODE_EXIT': '7'})
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual(self.node_args(), ['setup', '--dry-run'])

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

    def test_force_in_a_tty_stays_non_interactive(self):
        master, slave = pty.openpty()
        proc = None
        try:
            proc = subprocess.Popen(['bash', str(ROOT / 'setup.sh'), '--force'], env=self.env,
                                    stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)
            slave = None
            output = b''
            deadline = time.monotonic() + 10
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.fail('setup.sh did not finish under a TTY: ' + output.decode(errors='replace'))
                ready, _, _ = select.select([master], [], [], remaining)
                if not ready:
                    self.fail('setup.sh did not finish under a TTY: ' + output.decode(errors='replace'))
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            self.assertEqual(proc.wait(timeout=10), 0)
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
            if slave is not None:
                os.close(slave)
            os.close(master)
        self.assertIn('已废弃', output.decode(errors='replace'))
        args, stdin_tty = self.node_call()
        self.assertEqual(args, ['setup'])
        self.assertFalse(stdin_tty, '--force must not hand a TTY to the wizard')


if __name__ == '__main__':
    unittest.main()

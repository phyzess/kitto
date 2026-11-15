import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('versions', ROOT / 'lib/versions.py')
versions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versions)


class VersionTests(unittest.TestCase):
    def test_scoped_and_unscoped_specs(self):
        self.assertEqual(versions.npm_spec('npm:@scope/name@1.2.3'), ('@scope/name', '1.2.3'))
        self.assertEqual(versions.npm_spec('@scope/name'), ('@scope/name', None))
        self.assertEqual(versions.npm_spec('name@latest'), ('name', 'latest'))

    def test_skill_hash_includes_reference_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / 'SKILL.md').write_text('same skill')
            (path / 'reference.md').write_text('first')
            old = versions.tree_hash(path)
            (path / 'reference.md').write_text('changed')
            self.assertNotEqual(old, versions.tree_hash(path))

    def test_offline_report_never_fetches(self):
        with patch.object(versions, 'inventory', return_value=[]), patch.object(versions, 'upstream') as fetch:
            self.assertFalse(versions.report()['online'])
            fetch.assert_not_called()

    def test_report_deduplicates_upstream_requests(self):
        rows = [{'kind': 'npm', 'name': 'one'}, {'kind': 'npm', 'name': 'one'}]
        with patch.object(versions, 'inventory', return_value=rows), patch.object(versions, 'upstream', return_value={'channels': {'latest': '1', 'next': '2-rc.1'}}) as fetch:
            result = versions.report(True)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(result['components'][0]['upstream']['channels']['next'], '2-rc.1')
            self.assertNotIn('selected', result['components'][0])

    def test_network_failure_becomes_explicit_unknown(self):
        with patch.object(versions.urllib.request, 'urlopen', side_effect=TimeoutError('offline')):
            result = versions.upstream('npm', 'one')
            self.assertEqual(result['error'], 'offline')
            self.assertNotIn('version', result)

    def test_repository_inventory_finds_drift_without_starting_mcp(self):
        calls = []
        def fake(args):
            calls.append(args)
            return None
        with tempfile.TemporaryDirectory() as tmp, patch.object(versions, 'command', side_effect=fake):
            rows = versions.inventory(ROOT, tmp)
        conflicts = {r['name'] for r in rows if r.get('versionConflict')}
        self.assertIn('chrome-devtools-mcp', conflicts)
        self.assertEqual(len([r for r in rows if r['kind'] == 'skill']), 5)
        self.assertFalse(any('npx' in call or 'serve' in call for call in calls))
        self.assertTrue(all(r['installed'] is None for r in rows if r['owner'] == 'pi'))


if __name__ == '__main__':
    unittest.main()

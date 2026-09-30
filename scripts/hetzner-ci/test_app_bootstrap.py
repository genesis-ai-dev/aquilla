import json
import tempfile
import unittest
from pathlib import Path
from app_bootstrap import dependency_identity, clear_source


class DependencyCacheTests(unittest.TestCase):
    def test_source_changes_reuse_but_dependency_changes_invalidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / 'package.json'
            manifest.write_text(json.dumps({'dependencies': {'a': '1.0.0'}, 'scripts': {'prepare': 'husky'}}))
            (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9')
            before = dependency_identity(root)
            self.assertTrue(before[1])
            (root / 'app.ts').write_text('changed app source')
            self.assertEqual(before, dependency_identity(root))
            (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9\nchanged: true')
            self.assertNotEqual(before, dependency_identity(root))
            manifest.write_text(json.dumps({'scripts': {'postinstall': 'node generate.js'}}))
            self.assertFalse(dependency_identity(root)[1])

    def test_custom_configuration_and_patches_disable_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{"pnpm":{"patchedDependencies":{"x":"x.patch"}}}')
            self.assertFalse(dependency_identity(root)[1])
            (root / 'package.json').write_text('{}')
            for name in ('.npmrc', '.pnpmfile.cjs'):
                (root / name).write_text('custom')
                self.assertFalse(dependency_identity(root)[1])
                (root / name).unlink()

    def test_manifest_addition_or_removal_invalidates_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{}')
            before = dependency_identity(root)
            worker = root / 'auth-worker'
            worker.mkdir()
            (worker / 'package.json').write_text('{}')
            self.assertNotEqual(before, dependency_identity(root))

    def test_source_cleanup_preserves_dependencies_but_removes_deleted_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('node_modules', 'auth-worker/node_modules', 'src/old', 'packages/library/node_modules'):
                (root / name).mkdir(parents=True)
                (root / name / 'file.js').write_text('content')
            (root / 'auth-worker/package.json').write_text('{}')
            (root / 'link').symlink_to(root / 'node_modules', target_is_directory=True)
            clear_source(root)
            self.assertTrue((root / 'node_modules/file.js').exists())
            self.assertTrue((root / 'auth-worker/node_modules/file.js').exists())
            self.assertTrue((root / 'packages/library/node_modules/file.js').exists())
            self.assertFalse((root / 'src').exists())
            self.assertFalse((root / 'auth-worker/package.json').exists())
            self.assertFalse((root / 'link').exists())


if __name__ == '__main__':
    unittest.main()

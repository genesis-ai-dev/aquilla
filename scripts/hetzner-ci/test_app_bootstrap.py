import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from app_bootstrap import dependency_identity, clear_source, prebuild


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


class PrebuildTests(unittest.TestCase):
    """The build must run before the wrangler workers exist: on the 3.8 GB QA host
    the two together exceed the container cap, which is how job 1850 died."""
    ENV = {'VITE_AUTH_BASE': 'http://127.0.0.1:9787', 'VITE_FRONTIER_BASE': 'http://127.0.0.1:9787',
           'VITE_CHAT_BASE': 'http://127.0.0.1:9787/chat', 'VITE_SYNC_WORKER_HOST': '127.0.0.1:9788',
           'QA_BUILD_NODE_OPTIONS': '--max-old-space-size=1536'}

    def test_builds_once_with_the_browser_urls_when_e2e_up_can_skip_its_build(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch('app_bootstrap.subprocess.run') as run:
            root = Path(tmp)
            (root / 'dist').mkdir()
            self.assertTrue(prebuild(root, b'... process.env.E2E_PREBUILT_DIST === "1" ...', self.ENV))
            self.assertFalse((root / 'dist').exists(), 'a stale dist must never be served')
            run.assert_called_once()
            args, kwargs = run.call_args
            self.assertEqual(args[0][:4], ['pnpm', 'exec', 'vite', 'build'])
            self.assertIn('--mode', args[0]) and self.assertIn('test', args[0])
            self.assertEqual(kwargs['env']['VITE_AUTH_BASE'], 'http://127.0.0.1:9787')
            self.assertEqual(kwargs['env']['VITE_GOOGLE_CLIENT_ID'], '')
            self.assertEqual(kwargs['env']['NODE_OPTIONS'], '--max-old-space-size=1536')
            self.assertTrue(kwargs['check'])

    def test_an_older_e2e_up_builds_itself_so_nothing_builds_twice(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch('app_bootstrap.subprocess.run') as run:
            self.assertFalse(prebuild(Path(tmp), b'runOnce("npx", ["vite", "build"])', self.ENV))
            run.assert_not_called()

    def test_missing_browser_urls_leave_the_build_to_e2e_up(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch('app_bootstrap.subprocess.run') as run:
            env = {key: value for key, value in self.ENV.items() if key != 'VITE_SYNC_WORKER_HOST'}
            self.assertFalse(prebuild(Path(tmp), b'E2E_PREBUILT_DIST', env))
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()

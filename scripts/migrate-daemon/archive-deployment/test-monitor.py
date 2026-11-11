"""Run against a staged monitor directory; never sends a heartbeat or alert."""
import sys
import unittest
sys.path.insert(0, sys.argv.pop(1))
from test_monitor import MonitorTests, evidence, job, m, NOW

class ArchiveMonitorTests(unittest.TestCase):
    def test_skips_stay_visible_and_new_errors_alert(self):
        e = evidence()
        e['jobs'] = [job(stage='skipped_archived')]
        result = m.evaluate(e, NOW)
        self.assertEqual(result['reasons'], [])
        self.assertIn('skipped_archived', str(result))
        for error in ['HTTP 409 placement changed', 'HTTP 503 service unavailable']:
            e['jobs'] = [job(stage='skipped_archived', error=error)]
            self.assertTrue(m.evaluate(e, NOW)['reasons'])
        old = job(error='old failure')
        exceptions = [dict(fingerprint=m.fingerprint('job', old), expires_at=NOW+500)]
        e['jobs'] = [dict(old, sha='b'*40)]
        self.assertTrue(m.evaluate(e, NOW, exceptions)['reasons'])

unittest.main()

#!/usr/bin/env python3
"""Exercise deployment orchestration with fake Docker; never access a real server."""
import os
import pathlib
import subprocess
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).with_name('deploy-production.sh').read_text()
REVISION = 'a' * 40


class DeploymentTests(unittest.TestCase):
    def run_deploy(self, failure=''):
        with tempfile.TemporaryDirectory() as folder:
            base = pathlib.Path(folder)
            root = base / 'opt'
            (root / 'aigenerate').mkdir(parents=True)
            (root / 'aigenerate' / '.env').write_text('NOT_A_REAL_SECRET=test\n')
            (root / 'aigenerate' / 'docker-compose.prod.yml').write_text('services: {}\n')
            release = root / 'intexa-releases' / ('backend-' + REVISION)
            release.mkdir(parents=True)
            (release / 'docker-compose.prod.yml').write_text('services: {}\n')
            binary = base / 'bin'
            binary.mkdir()
            docker = binary / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['LOG'],'a') as f:f.write(json.dumps(args)+'\\n')
failure=os.environ.get('FAILURE','')
if args[0]=='inspect':print('sha256:previous-image')
elif 'build' in args and failure=='build':sys.exit(1)
elif 'pg_dump' in args:
 if failure=='backup':sys.exit(1)
 print('fake-database-backup')
elif 'psql' in args:print(0)
elif 'node' in args:
 code=args[-1]
 if 'inFlight' in code:print(0)
 if "/health'" in code and failure=='health':sys.exit(1)
elif 'up' in args and failure=='rollback':sys.exit(1)
elif 'up' in args and failure=='switch' and any(x.endswith('images.yml') for x in args):sys.exit(1)
''')
            docker.chmod(0o755)
            curl = binary / 'curl'
            curl.write_text('#!/bin/sh\nexit 0\n')
            curl.chmod(0o755)
            script = base / 'deploy.sh'
            script.write_text(SOURCE.replace('/opt/', str(root) + '/'))
            log = base / 'log'
            env = dict(os.environ, PATH=str(binary)+':'+os.environ['PATH'], LOG=str(log), FAILURE=failure)
            result = subprocess.run(['bash', str(script), 'backend', REVISION], env=env, capture_output=True, text=True)
            import json
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            rolled_back = any('up' in call and any(x.endswith('rollback.yml') for x in call) for call in calls)
            released_gate = any('node' in call and 'rmSync' in call[-1] for call in calls)
            return result.returncode, rolled_back, released_gate, result.stdout + result.stderr

    def test_success(self):
        code, rollback, gate, output = self.run_deploy()
        self.assertEqual(code, 0, output)
        self.assertFalse(rollback)
        self.assertTrue(gate)

    def test_build_failure_keeps_running_release(self):
        code, rollback, gate, _ = self.run_deploy('build')
        self.assertNotEqual(code, 0)
        self.assertFalse(rollback)
        self.assertFalse(gate)

    def test_backup_failure_reopens_generation_without_switch(self):
        code, rollback, gate, _ = self.run_deploy('backup')
        self.assertNotEqual(code, 0)
        self.assertFalse(rollback)
        self.assertTrue(gate)

    def test_failed_switch_rolls_back(self):
        code, rollback, gate, _ = self.run_deploy('switch')
        self.assertNotEqual(code, 0)
        self.assertTrue(rollback)
        self.assertTrue(gate)

    def test_failed_health_check_rolls_back(self):
        code, rollback, gate, _ = self.run_deploy('health')
        self.assertNotEqual(code, 0)
        self.assertTrue(rollback)
        self.assertTrue(gate)

    def test_failed_rollback_keeps_gate_closed(self):
        code, rollback, gate, output = self.run_deploy('rollback')
        self.assertNotEqual(code, 0)
        self.assertTrue(rollback)
        self.assertFalse(gate)
        self.assertIn('ROLLBACK FAILED', output)


if __name__ == '__main__':
    unittest.main()

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('backend environment loads when launched from the repository or frontend directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fmb-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const utilityDirectory = path.join(directory, 'backend', 'src', 'utils');
  const frontendDirectory = path.join(directory, 'frontend');
  await mkdir(utilityDirectory, { recursive: true });
  await mkdir(frontendDirectory);
  const modulePath = path.join(utilityDirectory, 'env.mjs');
  await copyFile(new URL('./env.js', import.meta.url), modulePath);
  await writeFile(path.join(directory, 'backend', '.env'), 'FMB_TEST_ENV_LOCAL=loaded\nFMB_TEST_ENV_OVERRIDE=file\n');
  const script = `import { loadEnv } from ${JSON.stringify(pathToFileURL(modulePath).href)}; loadEnv(); console.log(JSON.stringify([process.env.FMB_TEST_ENV_LOCAL, process.env.FMB_TEST_ENV_OVERRIDE]));`;
  for (const cwd of [directory, frontendDirectory]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd, encoding: 'utf8', env: { ...process.env, FMB_TEST_ENV_OVERRIDE: 'deployment' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['loaded', 'deployment']);
  }
});

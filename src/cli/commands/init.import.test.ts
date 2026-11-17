import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pki, fingerprintPem, type Credential } from '../../pki.ts';
import type { ResolvedCliConfig } from '../config.ts';
import { importCredential } from './init.ts';
import { testRuntime } from '../../../tests/cli-runtime.ts';

const LIFETIME_MS = 24 * 60 * 60 * 1000;

/** A runtime whose credentials directory is private to the test, plus the config an import starts from. */
async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-init-import-'));
  const credentials = path.join(dir, 'credentials');
  const run = testRuntime({ env: { ...process.env, TUG_CREDENTIALS_DIR: credentials } });
  return {
    ...run,
    credentials,
    cfg: {
      file: path.join(dir, 'cfg.yml'),
      fileExists: false,
      localFile: path.join(dir, 'cfg.local.yml'),
      commandDefaults: {},
      nodeDefaults: {},
      nodes: {},
      project: 'site',
    } as unknown as ResolvedCliConfig,
  };
}

async function credential(
  pki: Awaited<ReturnType<typeof Pki.load>>,
  name: string,
): Promise<Credential> {
  const issued = await pki.issueClient(
    `tug:operator:cred_${name}`,
    LIFETIME_MS,
    'https://control.test:8443',
  );
  return issued.credential;
}

const ca12 = (cred: Credential) =>
  fingerprintPem(cred.ca).replace(/:/g, '').toLowerCase().slice(0, 12);

test('importCredential records the first credential without a CA-change notice', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  await importCredential(h.rt, h.cfg, JSON.stringify(await credential(pki, 'first')), {});
  assert.ok(
    !h.stderr().includes('signed by CA'),
    'the first import cannot be a CA change and must not warn',
  );
});

test('the imported file name embeds the credential CA fingerprint', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const cred = await credential(pki, 'named');
  await importCredential(h.rt, h.cfg, JSON.stringify(cred), {});
  assert.match(
    h.stdout(),
    new RegExp(`control\\.test_8443\\.${ca12(cred)}\\.json`),
    'the imported file name carries the CA fingerprint prefix',
  );
  await fs.access(path.join(h.credentials, `control.test_8443.${ca12(cred)}.json`));
});

test('importing a credential from a different CA never overwrites the previously imported file', async () => {
  const h = await harness();
  const first = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const second = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-b-')), true);
  const oldCred = await credential(first, 'old');
  const newCred = await credential(second, 'new');
  assert.notEqual(
    fingerprintPem(oldCred.ca),
    fingerprintPem(newCred.ca),
    'the test setup must use two different CAs',
  );

  h.cfg.credential = oldCred;
  await importCredential(h.rt, h.cfg, JSON.stringify(oldCred), {});
  // The resolved config still points at the previous credential when the replacement is imported;
  // `writeInitConfig` flips the pointer only after the import decision.
  h.cfg.credentialFile = path.join(h.credentials, `control.test_8443.${ca12(oldCred)}.json`);
  await importCredential(h.rt, h.cfg, JSON.stringify(newCred), {});

  const oldPath = path.join(h.credentials, `control.test_8443.${ca12(oldCred)}.json`);
  const newPath = path.join(h.credentials, `control.test_8443.${ca12(newCred)}.json`);
  const oldFile = JSON.parse(await fs.readFile(oldPath, 'utf8'));
  const newFile = JSON.parse(await fs.readFile(newPath, 'utf8'));
  assert.equal(
    oldFile.ca,
    oldCred.ca,
    'the previously working credential file is untouched after a different-CA import',
  );
  assert.equal(
    newFile.ca,
    newCred.ca,
    'the different-CA credential is written to its own fingerprint-named file',
  );
  assert.ok(
    h.stderr().includes(fingerprintPem(newCred.ca)),
    'the warning names the incoming credential CA fingerprint',
  );
  assert.match(
    h.stderr(),
    /previous file stays/,
    'the warning points at the preserved previous file',
  );
});

test('re-importing the same CA credential reuses one file (idempotent, no name churn)', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const cred = await credential(pki, 'stable');
  await importCredential(h.rt, h.cfg, JSON.stringify(cred), {});
  await importCredential(h.rt, h.cfg, JSON.stringify(cred), {});
  const files = (await fs.readdir(h.credentials)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, 'two imports of one credential produce one file');
  assert.equal(
    JSON.parse(await fs.readFile(files[0] && path.join(h.credentials, files[0]), 'utf8')).ca,
    cred.ca,
  );
});

test('replacing a credential whose CA is unreadable still imports and skips the CA-change notice', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-bad-')), true);
  const good = await credential(pki, 'repair');
  h.cfg = { ...h.cfg, credential: { ...good, ca: 'not a certificate' } } as ResolvedCliConfig;
  await importCredential(h.rt, h.cfg, JSON.stringify(good), {});
  assert.ok(
    !h.stderr().includes('signed by CA'),
    'a corrupt previous credential is exactly what a re-import repairs; it must not block or confuse the import',
  );
});

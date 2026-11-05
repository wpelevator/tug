import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pki, fingerprintPem, type Credential } from '../pki.ts';
import type { ResolvedCliConfig } from '../cli-config.ts';
import { importCredential } from './init.ts';

const LIFETIME_MS = 24 * 60 * 60 * 1000;

interface Harness {
  cfg: ResolvedCliConfig;
}

async function harness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-init-import-'));
  // Keep imports out of the real user config directory; importCredential reads this on every call.
  process.env.TUG_CREDENTIALS_DIR = path.join(dir, 'credentials');
  return {
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

async function credential(pki: Awaited<ReturnType<typeof Pki.load>>, name: string): Promise<Credential> {
  const issued = await pki.issueClient(`tug:operator:cred_${name}`, LIFETIME_MS, 'https://control.test:8443');
  return issued.credential;
}

test('importCredential records the first credential without a CA-change notice', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    await importCredential(h.cfg, JSON.stringify(await credential(pki, 'first')), {});
  } finally {
    console.error = original;
  }
  assert.ok(
    !errors.some((line) => line.includes('signed by CA')),
    'the first import cannot be a CA change and must not warn',
  );
});

test('the imported file name embeds the credential CA fingerprint', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const cred = await credential(pki, 'named');
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(' '));
  try {
    await importCredential(h.cfg, JSON.stringify(cred), {});
  } finally {
    console.log = original;
  }
  const ca12 = fingerprintPem(cred.ca).replace(/:/g, '').toLowerCase().slice(0, 12);
  assert.match(
    printed.join('\n'),
    new RegExp(`control\\.test_8443\\.${ca12}\\.json`),
    'the imported file name carries the CA fingerprint prefix',
  );
  await fs.access(path.join(process.env.TUG_CREDENTIALS_DIR!, `control.test_8443.${ca12}.json`));
});

test('importing a credential from a different CA never overwrites the previously imported file', async () => {
  const h = await harness();
  const first = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const second = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-b-')), true);
  const oldCred = await credential(first, 'old');
  const newCred = await credential(second, 'new');
  assert.notEqual(fingerprintPem(oldCred.ca), fingerprintPem(newCred.ca), 'the test setup must use two different CAs');

  h.cfg.credential = oldCred;
  const errors: string[] = [];
  const original = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  console.log = () => {};
  try {
    await importCredential(h.cfg, JSON.stringify(oldCred), {});
    // The resolved config still points at the previous credential when the replacement is imported;
    // `writeInitConfig` flips the pointer only after the import decision.
    h.cfg.credentialFile = path.join(process.env.TUG_CREDENTIALS_DIR!, `control.test_8443.${fingerprintPem(oldCred.ca).replace(/:/g, '').toLowerCase().slice(0, 12)}.json`);
    await importCredential(h.cfg, JSON.stringify(newCred), {});
  } finally {
    console.error = original;
    console.log = originalLog;
  }

  const caOld = fingerprintPem(oldCred.ca).replace(/:/g, '').toLowerCase().slice(0, 12);
  const caNew = fingerprintPem(newCred.ca).replace(/:/g, '').toLowerCase().slice(0, 12);
  const oldPath = path.join(process.env.TUG_CREDENTIALS_DIR!, `control.test_8443.${caOld}.json`);
  const newPath = path.join(process.env.TUG_CREDENTIALS_DIR!, `control.test_8443.${caNew}.json`);
  const oldFile = JSON.parse(await fs.readFile(oldPath, 'utf8'));
  const newFile = JSON.parse(await fs.readFile(newPath, 'utf8'));
  assert.equal(oldFile.ca, oldCred.ca, 'the previously working credential file is untouched after a different-CA import');
  assert.equal(newFile.ca, newCred.ca, 'the different-CA credential is written to its own fingerprint-named file');
  assert.ok(
    errors.join('\n').includes(fingerprintPem(newCred.ca)),
    'the warning names the incoming credential CA fingerprint',
  );
  assert.match(errors.join('\n'), /previous file stays/, 'the warning points at the preserved previous file');
});

test('re-importing the same CA credential reuses one file (idempotent, no name churn)', async () => {
  const h = await harness();
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-a-')), true);
  const cred = await credential(pki, 'stable');
  const originalLog = console.log;
  console.log = () => {};
  try {
    await importCredential(h.cfg, JSON.stringify(cred), {});
    await importCredential(h.cfg, JSON.stringify(cred), {});
  } finally {
    console.log = originalLog;
  }
  const dir = process.env.TUG_CREDENTIALS_DIR!;
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, 'two imports of one credential produce one file');
  assert.equal(JSON.parse(await fs.readFile(files[0] && path.join(dir, files[0]), 'utf8')).ca, cred.ca);
});

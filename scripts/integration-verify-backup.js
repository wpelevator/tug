#!/usr/bin/env node
const control = process.env.LAUNCHPAD_CONTROL_URL || 'http://localhost:8080';
const token = process.env.LAUNCHPAD_TOKEN || 'integration-token';
const project = process.env.LAUNCHPAD_PROJECT || 'sample';
const backupId = process.env.LAUNCHPAD_BACKUP_ID;
const timeoutMs = Number(process.env.LAUNCHPAD_VERIFY_TIMEOUT_MS || 120000);
if (!backupId) throw new Error('LAUNCHPAD_BACKUP_ID required');

async function list() {
  const res = await fetch(`${control}/api/v1/backups?project=${encodeURIComponent(project)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`backups: ${res.status} ${await res.text()}`);
  return res.json();
}

const started = Date.now();
let last;
while (Date.now() - started < timeoutMs) {
  last = await list();
  const backup = last.backups.find(b => b.id === backupId);
  if (backup?.state === 'completed' && backup.artifact_ref) {
    console.log(JSON.stringify({ ok: true, backupId, artifactRef: backup.artifact_ref }, null, 2));
    process.exit(0);
  }
  if (backup?.state === 'failed') {
    console.error(JSON.stringify({ ok: false, backup }, null, 2));
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2000));
}
console.error(JSON.stringify({ ok: false, last }, null, 2));
process.exit(1);

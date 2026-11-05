import test from 'node:test';
import assert from 'node:assert/strict';
import { caTrustCode, fingerprintPem, describeCaMismatch, type Credential } from './pki.ts';

const ca = `-----BEGIN CERTIFICATE-----
MIIBZDCCAQqgAwIBAgIPE14zhIG4l7ov73HrXf7IMAoGCCqGSM49BAMCMBExDzAN
BgNVBAMTBlR1ZyBDQTAeFw0yNjExMDMxMjExMTdaFw0zNjEwMzExMjE2MTdaMBEx
DzANBgNVBAMTBlR1ZyBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPvcSrh8
gs4a5xIESPh974gHJAuxkBFJmvsbHuFrA224mxbFVEKOoO7saAlcjGCvN5UbTSpZ
EWtONC/NhVy4pRWjRTBDMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQD
AgEGMB0GA1UdDgQWBBRqkA4dTcleXJEGZ3qSzwM8XhLy0TAKBggqhkjOPQQDAgNI
ADBFAiAAwCnZvTdU2x/xir3jnaN96kDuQNrfCgBYuDu04BD4DgIhALancVJy0kmu
K7slIBiXx6Oy1b1BL+UNXopyDUVNhgQI
-----END CERTIFICATE-----
`;
const credential: Credential = { v: 1, url: 'https://control:8443', ca, cert: ca, key: 'unused' };

test('caTrustCode names the chain-verification failure by node error code', () => {
  const error = new Error('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
  assert.equal(caTrustCode(error), 'SELF_SIGNED_CERT_IN_CHAIN', 'node codes are reported verbatim');
});

test('caTrustCode falls back to the message text for transports that lose the code', () => {
  assert.equal(
    caTrustCode(new Error('self-signed certificate in certificate chain')),
    'CA verification declined',
    'an openssl-text-only failure is still classified',
  );
  assert.equal(
    caTrustCode(new Error('network unreachable')),
    null,
    'unrelated failures stay unclassified',
  );
  assert.equal(caTrustCode(undefined), null, 'a missing error is not a trust failure');
});

test('fingerprintPem is the certificate SHA-256 fingerprint', () => {
  assert.match(
    fingerprintPem(ca),
    /^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/,
    'OpenSSL-style SHA-256 colon fingerprint',
  );
});

test('describeCaMismatch names the trusted CA fingerprint and both remediations', () => {
  const message = describeCaMismatch(credential, 'https://control:8443');
  assert.match(
    message,
    /this credential trusts [A-F0-9]/,
    'the trusted CA fingerprint is in the message',
  );
  assert.match(message, /tug init/, 're-importing the matching credential is suggested');
  assert.match(message, /redeploy that control/, 'redeploying the control is suggested');
});

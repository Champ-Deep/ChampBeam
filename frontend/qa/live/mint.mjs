// Mints test-key Clerk-style JWTs for the LOCAL Worker only (CLERK_JWKS_JSON pinned to the repo test key).
import { SignJWT, importJWK } from '../../../worker/node_modules/jose/dist/webapi/index.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const key = JSON.parse(readFileSync(new URL('../../../worker/test/fixtures/clerk-test-key.json', import.meta.url)));
const priv = await importJWK(key.private, 'RS256');
const out = {};
for (const [org, role] of [['a','admin'],['a','member'],['a','viewer'],['b','admin'],['b','member']]) {
  const sub = `user_qa_${org}_${role}`;
  out[`${org}:${role}`] = await new SignJWT({ sub, email: `${sub}@qa.invalid`, o: { id: `org_qa_${org}`, rol: `org:${role}`, slg: `qa-${org}` } })
    .setProtectedHeader({ alg: 'RS256', kid: key.private.kid }).setIssuedAt().setExpirationTime('8h').sign(priv);
}
mkdirSync(new URL('../../../.verify/live/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../../.verify/live/tokens.json', import.meta.url), JSON.stringify(out));
writeFileSync(new URL('../../../worker/.dev.vars', import.meta.url),
  `ENVIRONMENT=development\nDEBUG=true\nFRONTEND_URL=http://127.0.0.1:3300\nREDIRECT_BASE_URL=http://127.0.0.1:8799\nPLATFORM_REDIRECT_HOST=127.0.0.1\nSHARE_ORIGIN_HOSTS=localhost\nSTORAGE_UPLOAD_SECRET=qa-local-upload-secret\nCLERK_JWKS_JSON='${JSON.stringify(key.jwks)}'\n`);
console.log('minted', Object.keys(out));

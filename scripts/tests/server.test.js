'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createServer } = require('../../server.js');

let tempDir;
let root;
let server;
let baseUrl;

function request(pathname, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, options || {}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sollaunchpad-server-test-'));
  root = path.join(tempDir, 'public');
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../public/js/config.js'), path.join(root, 'js/config.js'));
  fs.writeFileSync(path.join(root, 'index.html'), 'test page');
  fs.mkdirSync(path.join(tempDir, 'public-backup'));
  fs.writeFileSync(path.join(tempDir, 'public-backup', 'private.txt'), 'do not serve');
  try { fs.symlinkSync(path.join(tempDir, 'public-backup', 'private.txt'), path.join(root, 'leak.txt')); } catch (_) { /* symlink may be restricted */ }

  server = createServer({
    root,
    rpcDevnet: "https://rpc.example/?key=';window.injected=true;//",
    rpcMainnet: 'https://rpc-mainnet.example/',
    jupiterApiKey: 'public-test-key',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('injects runtime config as escaped literals, not executable source', async () => {
  const res = await request('/js/config.js');
  assert.equal(res.status, 200);
  const window = {};
  vm.runInNewContext(res.body, { window });
  assert.equal(window.APP_CONFIG.RPC_URLS.devnet, "https://rpc.example/?key=';window.injected=true;//");
  assert.equal(window.APP_CONFIG.RPC_URLS['mainnet-beta'], 'https://rpc-mainnet.example/');
  assert.equal(window.APP_CONFIG.JUPITER_API_KEY, 'public-test-key');
  assert.equal(window.injected, undefined);
  assert.equal(res.headers['cache-control'], 'no-cache');
  const head = await request('/js/config.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('serves app files, rejects traversal/symlink escapes, and handles invalid URLs', async () => {
  assert.equal((await request('/')).body, 'test page');
  for (const pathname of ['/%2e%2e%5cpublic-backup%5cprivate.txt', '/leak.txt']) {
    const res = await request(pathname);
    assert.notEqual(res.status, 200);
    assert.notEqual(res.body, 'do not serve');
  }
  assert.equal((await request('/bad%ZZ')).status, 400);
});

test('allows only GET and HEAD and does not send a body for HEAD', async () => {
  assert.equal((await request('/', { method: 'POST' })).status, 405);
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
});

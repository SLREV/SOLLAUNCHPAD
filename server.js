/**
 * server.js — Server statis ringan untuk SOLLAUNCHPAD (tanpa dependensi, hanya modul bawaan Node.js).
 *
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js  → port lain
 *
 * Opsional: buat file .env (lihat .env.example) untuk mengganti RPC URL.
 * Nilai tersebut disuntikkan ke /js/config.js saat disajikan.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const env = loadEnv(path.join(__dirname, '.env'));
const PORT = parseInt(process.env.PORT || env.PORT || '3000', 10);
const HOST = process.env.HOST || env.HOST || '0.0.0.0';
const RPC_DEVNET = process.env.RPC_DEVNET || env.RPC_DEVNET || '';
const RPC_MAINNET = process.env.RPC_MAINNET || env.RPC_MAINNET || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Parser .env sederhana (KEY=VALUE, abaikan komentar) */
function loadEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch (_) {
    /* .env tidak ada → pakai default */
  }
  return out;
}

/** Sisipkan RPC override dari .env ke config.js tanpa mengubah file aslinya */
function serveConfig(res) {
  let js = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
  if (RPC_DEVNET) js = js.replace(/devnet:\s*'[^']*'/, `devnet: '${RPC_DEVNET}'`);
  if (RPC_MAINNET) js = js.replace(/'mainnet-beta':\s*'[^']*'/, `'mainnet-beta': '${RPC_MAINNET}'`);
  res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
  res.end(js);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));

  // Cegah path traversal keluar dari folder public
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (urlPath === '/js/config.js') return serveConfig(res);

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // vendor (web3 / raydium) boleh di-cache lama oleh browser; file app selalu dicek ulang
        'Cache-Control': isVendor ? 'public, max-age=604800' : 'no-cache',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  SOLLAUNCHPAD — Solana Token Launchpad (lite)');
  console.log(`  ➜  http://localhost:${PORT}`);
  if (RPC_DEVNET) console.log(`  RPC devnet  : ${RPC_DEVNET}`);
  if (RPC_MAINNET) console.log(`  RPC mainnet : ${RPC_MAINNET}`);
  console.log('');
});

/**
 * Lightweight static server for SOLLAUNCHPAD (Node.js built-ins only).
 *
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js  -> another port
 *
 * Optional .env values are injected into the browser config. RPC URLs and API keys
 * served this way are public to every visitor; use browser-restricted credentials.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Simple KEY=VALUE .env parser. */
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
    // Missing .env is expected; process.env and defaults are used instead.
  }
  return out;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(message);
}

/** Create a server instance; exported for deterministic HTTP tests. */
function createServer(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const rootReal = fs.realpathSync(root);
  const rpcDevnet = opts.rpcDevnet || '';
  const rpcMainnet = opts.rpcMainnet || '';
  const jupiterApiKey = opts.jupiterApiKey || '';

  function serveConfig(req, res) {
    const configPath = path.join(root, 'js', 'config.js');
    fs.realpath(configPath, (realErr, configReal) => {
      if (realErr) return sendText(res, 404, '404 Not Found');
      if (!isInside(rootReal, configReal)) return sendText(res, 403, '403 Forbidden');
      fs.readFile(configReal, 'utf8', (readErr, source) => {
        if (readErr) return sendText(res, 404, '404 Not Found');
        let js = source;
        // Serialize values as JavaScript string literals instead of interpolating raw text.
        if (rpcDevnet) {
          js = js.replace(/(devnet:\s*)'[^']*'/, (_match, prefix) => prefix + JSON.stringify(rpcDevnet));
        }
        if (rpcMainnet) {
          js = js.replace(/('mainnet-beta':\s*)'[^']*'/, (_match, prefix) => prefix + JSON.stringify(rpcMainnet));
        }
        if (jupiterApiKey) {
          js = js.replace(/(JUPITER_API_KEY:\s*)'[^']*'/, (_match, prefix) => prefix + JSON.stringify(jupiterApiKey));
        }
        res.writeHead(200, {
          'Content-Type': MIME['.js'],
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : js);
      });
    });
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405 Method Not Allowed');
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch (_) {
      return sendText(res, 400, '400 Bad Request');
    }
    if (urlPath.includes('\0')) return sendText(res, 400, '400 Bad Request');

    // Treat backslashes as separators too, so traversal is blocked consistently across platforms.
    const relativePath = urlPath.replace(/\\/g, '/').replace(/^\/+/, '') || 'index.html';
    let filePath = path.resolve(root, relativePath);
    if (!isInside(root, filePath)) return sendText(res, 403, '403 Forbidden');

    if (urlPath === '/js/config.js') return serveConfig(req, res);

    fs.stat(filePath, (statErr, stat) => {
      if (statErr) return sendText(res, 404, '404 Not Found');
      if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');

      // Resolve symlinks before reading so a link inside public cannot expose sibling files.
      fs.realpath(filePath, (realErr, realPath) => {
        if (realErr) return sendText(res, 404, '404 Not Found');
        if (!isInside(rootReal, realPath)) return sendText(res, 403, '403 Forbidden');

        fs.readFile(realPath, (readErr, data) => {
          if (readErr) return sendText(res, 404, '404 Not Found');
          const ext = path.extname(realPath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            // Assets use stable URLs, so always revalidate instead of serving stale vendor bundles.
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
      });
    });
  });
}

if (require.main === module) {
  const env = loadEnv(path.join(__dirname, '.env'));
  const parsedPort = Number.parseInt(process.env.PORT || env.PORT || '3000', 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
  const host = process.env.HOST || env.HOST || '0.0.0.0';
  const rpcDevnet = process.env.RPC_DEVNET || env.RPC_DEVNET || '';
  const rpcMainnet = process.env.RPC_MAINNET || env.RPC_MAINNET || '';
  const jupiterApiKey = process.env.JUPITER_API_KEY || env.JUPITER_API_KEY || '';
  const server = createServer({ rpcDevnet, rpcMainnet, jupiterApiKey });

  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    console.log('');
    console.log('  SOLLAUNCHPAD — Solana Token Launchpad (lite)');
    console.log(`  ➜  http://localhost:${listeningPort}`);
    if (rpcDevnet) console.log(`  RPC devnet  : ${rpcDevnet}`);
    if (rpcMainnet) console.log(`  RPC mainnet : ${rpcMainnet}`);
    console.log('');
  });
}

module.exports = { createServer, loadEnv, isInside };

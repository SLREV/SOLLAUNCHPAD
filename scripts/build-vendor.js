/**
 * Build file vendor untuk browser:
 *   1. public/vendor/solana-web3.min.js  — salinan IIFE resmi @solana/web3.js
 *   2. public/vendor/raydium-sdk.js      — bundle @raydium-io/raydium-sdk-v2 (+ decimal.js, bn.js)
 *
 * Hanya perlu dijalankan jika ingin memperbarui versi library:
 *   npm install   (devDependencies)
 *   npm run build:vendor
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

// 1. web3.js IIFE
const web3Iife = require.resolve('@solana/web3.js/lib/index.iife.min.js');
fs.copyFileSync(web3Iife, path.join(vendorDir, 'solana-web3.min.js'));
console.log('✔ solana-web3.min.js');

// Plugin: arahkan semua import '@solana/web3.js' ke global window.solanaWeb3
// supaya hanya ada satu instance web3.js di halaman (lebih ringan, tanpa konflik class).
const web3GlobalPlugin = {
  name: 'solana-web3-global',
  setup(build) {
    build.onResolve({ filter: /^@solana\/web3\.js$/ }, () => ({ path: 'solana-web3-global', namespace: 'web3-global' }));
    build.onLoad({ filter: /.*/, namespace: 'web3-global' }, () => ({
      contents: 'module.exports = window.solanaWeb3;',
      loader: 'js',
    }));
  },
};

// 2. Raydium SDK bundle
esbuild
  .build({
    entryPoints: [path.join(__dirname, 'raydium-entry.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: path.join(vendorDir, 'raydium-sdk.js'),
    inject: [path.join(__dirname, 'buffer-shim.js')],
    define: {
      'process.env.NODE_ENV': '"production"',
      global: 'window',
    },
    plugins: [web3GlobalPlugin],
    logLevel: 'warning',
  })
  .then(() => {
    const size = fs.statSync(path.join(vendorDir, 'raydium-sdk.js')).size;
    console.log(`✔ raydium-sdk.js (${(size / 1024 / 1024).toFixed(2)} MB)`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

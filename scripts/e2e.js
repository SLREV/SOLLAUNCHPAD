/**
 * E2E test SOLLAUNCHPAD lite — Playwright + Chromium headless.
 *
 *   npm install                      (devDependencies)
 *   npm i -D playwright && npx playwright install chromium
 *   node server.js                   (di terminal lain)
 *   node scripts/e2e.js [baseUrl]
 *
 * Wallet Phantom disimulasikan di dalam halaman dengan keypair acak. RPC read-only
 * (rent, blockhash, data mint) tetap ke devnet asli; `sendTransaction` dicegat agar transaksi
 * yang sudah ditandatangani bisa diverifikasi strukturnya di Node tanpa membutuhkan SOL.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair, Transaction, VersionedTransaction, PublicKey, SystemProgram } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const BASE = process.argv[2] || 'http://localhost:3000';
const METAPLEX_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const testKp = Keypair.generate();
const SHOTS = path.join(os.tmpdir(), 'sollaunchpad-e2e');
fs.mkdirSync(SHOTS, { recursive: true });
console.log('Wallet uji:', testKp.publicKey.toBase58(), '| screenshot →', SHOTS);

const captured = []; // {method, raw(base64), label}
let currentLabel = 'init';
const consoleErrors = [];
let fakeSigCounter = 0;
function fakeSig() { fakeSigCounter++; return Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 44 - 1); }

function ok(cond, msg) { if (!cond) throw new Error('ASSERT FAIL: ' + msg); console.log('  ✔', msg); }

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // 1) Fake Phantom provider (dipasang sebelum skrip halaman jalan)
  await ctx.addInitScript((secretArr) => {
    const provider = {
      isPhantom: true,
      publicKey: null,
      _handlers: {},
      on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      async connect() {
        const { Keypair } = window.solanaWeb3;
        this._kp = Keypair.fromSecretKey(Uint8Array.from(secretArr));
        this.publicKey = this._kp.publicKey;
        return { publicKey: this.publicKey };
      },
      async disconnect() { this.publicKey = null; (this._handlers.disconnect || []).forEach((f) => f()); },
      async signTransaction(tx) {
        if (typeof tx.version === 'number' || tx.version === 0 || tx.version === 'legacy' && tx.message) {
          tx.sign([this._kp]);
        } else {
          tx.partialSign(this._kp);
        }
        return tx;
      },
    };
    window.phantom = { solana: provider };
    // Stub konfirmasi: kita tidak punya SOL devnet, jadi tx tidak benar2 masuk chain.
    const origConfirm = window.solanaWeb3 && window.solanaWeb3.Connection.prototype.confirmTransaction;
    Object.defineProperty(window, '__patchConfirm', {
      value: () => {
        window.solanaWeb3.Connection.prototype.confirmTransaction = async () => ({ context: { slot: 0 }, value: { err: null } });
      },
    });
  }, Array.from(testKp.secretKey));

  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  // 2) Cegat JSON-RPC: sendTransaction → tangkap; sisanya diteruskan ke devnet asli
  await page.route(/api\.(devnet|mainnet-beta)\.solana\.com/, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    let body;
    try { body = JSON.parse(req.postData() || '{}'); } catch (_) { return route.continue(); }
    const items = Array.isArray(body) ? body : [body];
    if (items.some((b) => b.method === 'sendTransaction')) {
      const results = items.map((b) => {
        if (b.method === 'sendTransaction') {
          captured.push({ label: currentLabel, raw: b.params[0], encoding: (b.params[1] && b.params[1].encoding) || 'base64' });
          return { jsonrpc: '2.0', id: b.id, result: fakeSig() };
        }
        return { jsonrpc: '2.0', id: b.id, result: null };
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? results : results[0]) });
    }
    return route.continue();
  });

  console.log('\n[1] Load halaman');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.solanaWeb3 && window.SplToken && window.Wallet);
  await page.evaluate(() => window.__patchConfirm());
  ok((await page.title()) === 'Token Creator', 'title = Token Creator');
  ok((await page.locator('.tab').count()) === 8, '8 tab navigasi');
  ok((await page.textContent('#status-addr')).trim() === 'DISCONNECTED', 'status DISCONNECTED');
  ok(await page.locator('#btn-create').isDisabled(), 'LAUNCH disabled sebelum connect');
  ok((await page.textContent('#btn-create')).trim() === 'LAUNCH DEVNET', 'label LAUNCH DEVNET');
  ok(await page.locator('[data-panel="create"] .need-wallet').isVisible(), 'pesan "Konektasikan wallet" tampil');
  ok(await page.locator('.net-info-devnet').first().isVisible(), 'info devnet tampil');
  ok(!(await page.locator('.net-info-mainnet').first().isVisible()), 'info mainnet tersembunyi');
  await page.screenshot({ path: `${SHOTS}/01-initial.png`, fullPage: true });

  console.log('\n[2] Connect wallet (Phantom simulasi)');
  await page.click('#btn-connect');
  await page.waitForSelector('#btn-disconnect');
  const short = testKp.publicKey.toBase58().slice(0, 4) + '...' + testKp.publicKey.toBase58().slice(-4);
  ok((await page.textContent('#status-addr')).trim() === short, 'status bar menampilkan alamat ' + short);
  ok((await page.textContent('.wallet-addr')).trim() === short, 'header menampilkan alamat');
  ok(await page.locator('#btn-create').isEnabled(), 'LAUNCH enabled setelah connect');
  ok(!(await page.locator('[data-panel="create"] .need-wallet').isVisible()), 'pesan "Konektasikan wallet" hilang');

  console.log('\n[3] Toggle jaringan');
  await page.click('#btn-mainnet');
  ok((await page.textContent('#btn-create')).trim() === 'LAUNCH MAINNET-BETA', 'label LAUNCH MAINNET-BETA (sesuai cluster.toUpperCase() di kode asli)');
  ok((await page.textContent('#status-net')).includes('MAINNET — REAL SOL FEES'), 'status MAINNET — REAL SOL FEES');
  ok((await page.textContent('#hdr-cluster')).trim() === 'MAINNET-BETA', 'header cluster MAINNET-BETA');
  ok((await page.getAttribute('#quick-explorer', 'href')).includes('cluster=mainnet-beta'), 'quick explorer link mainnet');
  ok(await page.locator('.net-info-mainnet').first().isVisible(), 'info mainnet tampil');
  ok(await page.locator('.fn-btn[data-network="mainnet-beta"]').evaluate((e) => e.classList.contains('active')), 'toggle melayang ikut aktif');
  await page.click('.fn-btn[data-network="devnet"]');
  ok((await page.textContent('#btn-create')).trim() === 'LAUNCH DEVNET', 'kembali ke DEVNET via toggle melayang');

  console.log('\n[4] CREATE TOKEN (devnet RPC asli untuk rent/blockhash, sendTransaction ditangkap)');
  currentLabel = 'create';
  await page.fill('#form-create [name=name]', 'Test Token');
  await page.fill('#form-create [name=symbol]', 'TST');
  await page.fill('#form-create [name=decimals]', '6');
  await page.fill('#form-create [name=initialSupply]', '12345');
  await page.click('#btn-create');
  await page.waitForSelector('#create-result .result-box', { timeout: 60000 });
  ok((await page.textContent('#create-result .result-title')).trim() === 'TOKEN BERHASIL DIBUAT', 'result box TOKEN BERHASIL DIBUAT');
  const createdMint = (await page.textContent('#create-result .result-val.green')).trim();
  ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(createdMint), 'mint base58 valid: ' + createdMint);
  ok((await page.locator('#create-result .dex-row a').count()) === 5, '5 tombol pintasan DEX');
  ok((await page.getAttribute('#create-result .dex-row a:nth-child(5)', 'href')) === `https://explorer.solana.com/address/${createdMint}?cluster=devnet`, 'link EXPLORER benar');
  ok((await page.textContent('#btn-create')).trim() === 'LAUNCH DEVNET', 'tombol kembali normal setelah selesai');
  await page.screenshot({ path: `${SHOTS}/02-create-result.png`, fullPage: true });

  console.log('\n[5] Verifikasi transaksi CREATE yang ditangkap');
  {
    const c = captured.find((x) => x.label === 'create');
    ok(c, 'transaksi tertangkap');
    const tx = Transaction.from(Buffer.from(c.raw, 'base64'));
    ok(tx.verifySignatures(), 'semua tanda tangan valid (wallet + mint keypair)');
    ok(tx.signatures.length === 2, '2 penandatangan');
    ok(tx.feePayer.equals(testKp.publicKey), 'fee payer = wallet');
    ok(tx.instructions.length === 5, '5 instruksi (4 SPL Token + metadata Metaplex)');
    const [ixCreate, ixInit, ixAta, ixMint, ixMeta] = tx.instructions;
    ok(ixMeta.programId.toBase58() === METAPLEX_PROGRAM && ixMeta.data[0] === 33, 'ix5 CreateMetadataAccountV3 (Metaplex)');
    ok(ixMeta.data.includes(Buffer.from('Test Token')) && ixMeta.data.includes(Buffer.from('TST')), 'metadata berisi nama & symbol');
    ok(ixCreate.programId.equals(SystemProgram.programId), 'ix1 SystemProgram.createAccount');
    const mintPk = ixCreate.keys[1].pubkey;
    ok(mintPk.toBase58() === createdMint, 'mint di tx = mint di UI');
    const space = Number(ixCreate.data.readBigUInt64LE(12));
    ok(space === 82, 'space mint = 82');
    ok(ixCreate.keys[1].isSigner, 'mint adalah signer');
    const refInit = spl.createInitializeMintInstruction(mintPk, 6, testKp.publicKey, null);
    ok(Buffer.compare(ixInit.data, refInit.data) === 0 && ixInit.programId.equals(spl.TOKEN_PROGRAM_ID), 'ix2 InitializeMint identik dgn spl-token (decimals 6)');
    const ata = spl.getAssociatedTokenAddressSync(mintPk, testKp.publicKey);
    const refAta = spl.createAssociatedTokenAccountInstruction(testKp.publicKey, ata, testKp.publicKey, mintPk);
    ok(ixAta.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID) && ixAta.keys.length === 6 && ixAta.keys.every((k, i) => k.pubkey.equals(refAta.keys[i].pubkey)) && ixAta.data.length === 0, 'ix3 CreateATA identik (payer, ata, owner, mint, system, token)');
    const refMintTo = spl.createMintToInstruction(mintPk, ata, testKp.publicKey, 12345 * 1e6);
    ok(Buffer.compare(ixMint.data, refMintTo.data) === 0, 'ix4 MintTo amount = 12345 × 10^6');
  }

  console.log('\n[6] TOKEN LIST');
  await page.click('.tab[data-tab="list"]');
  ok((await page.locator('#token-list tbody tr').count()) === 1, '1 baris token');
  ok((await page.textContent('#token-list tbody tr td:nth-child(1)')).trim() === 'Test Token', 'nama = Test Token');
  ok((await page.textContent('#token-list tbody tr td.sym')).trim() === 'TST', 'symbol = TST');
  ok((await page.textContent('#token-list tbody tr td.sup')).trim() === '12345', 'supply = 12345');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('token-creator-tokens')));
  ok(stored.length === 1 && stored[0].mint === createdMint && stored[0].decimals === 6, 'localStorage token-creator-tokens tersimpan');
  await page.screenshot({ path: `${SHOTS}/03-token-list.png`, fullPage: true });

  console.log('\n[7] CLONE TOKEN (AMBIL DATA dari devnet asli)');
  const USDC_DEV = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  await page.click('.tab[data-tab="clone"]');
  ok(await page.locator('#btn-clone-fetch').isDisabled(), 'AMBIL DATA disabled saat input kosong');
  await page.fill('#clone-input', USDC_DEV);
  ok(await page.locator('#btn-clone-fetch').isEnabled(), 'AMBIL DATA enabled setelah input');
  await page.click('#btn-clone-fetch');
  await page.waitForSelector('#clone-data .source-box', { timeout: 60000 });
  const decTxt = (await page.textContent('#clone-data .kv-grid div:nth-child(2) .v')).trim();
  ok(decTxt === '6', 'decimals sumber = 6 (USDC devnet)');
  ok((await page.inputValue('#form-clone [name=decimals]')) === '6', 'form clone terisi decimals 6');
  const srcName = await page.inputValue('#form-clone [name=name]');
  const srcSymbol = await page.inputValue('#form-clone [name=symbol]');
  ok(srcName.length > 0 && srcSymbol.length > 0, `form clone nama/symbol dari metadata sumber (atau default): ${srcName} / ${srcSymbol}`);
  const supplyVal = await page.inputValue('#form-clone [name=initialSupply]');
  ok(parseFloat(supplyVal) > 0, 'supply sumber terisi: ' + supplyVal);
  // ubah lalu pakai parameter sumber lagi
  await page.fill('#form-clone [name=name]', 'XXX');
  await page.click('#btn-use-source');
  ok((await page.inputValue('#form-clone [name=name]')) === srcName, '[GUNAKAN PARAMETER INI] mengembalikan nama');
  currentLabel = 'clone';
  await page.fill('#form-clone [name=initialSupply]', '500');
  await page.click('#btn-clone');
  await page.waitForSelector('#clone-result .result-box', { timeout: 60000 });
  ok((await page.textContent('#clone-result .result-title')).trim() === 'CLONE BERHASIL DIBUAT', 'CLONE BERHASIL DIBUAT');
  {
    const c = captured.find((x) => x.label === 'clone');
    const tx = Transaction.from(Buffer.from(c.raw, 'base64'));
    ok(tx.verifySignatures() && tx.instructions.length === 5, 'tx clone valid, 5 instruksi (termasuk metadata)');
    ok(tx.instructions[4].programId.toBase58() === METAPLEX_PROGRAM && tx.instructions[4].data.includes(Buffer.from(srcName)), 'metadata clone memakai nama sumber');
    ok(tx.instructions[1].data[1] === 6, 'decimals clone = 6');
    ok(Number(tx.instructions[3].data.readBigUInt64LE(1)) === 500 * 1e6, 'mint amount = 500 × 10^6');
  }
  await page.click('.tab[data-tab="list"]');
  ok((await page.locator('#token-list tbody tr').count()) === 2, 'token list = 2 baris (terbaru di atas)');
  await page.screenshot({ path: `${SHOTS}/04-clone.png`, fullPage: true });

  console.log('\n[8] TOKEN-2022 TRANSFER FEE');
  currentLabel = 't22';
  await page.click('.tab[data-tab="token2022"]');
  await page.fill('#form-t22 [name=transferFeeBasisPoints]', '250');
  await page.fill('#form-t22 [name=transferFeeMax]', '5000000');
  await page.click('#btn-t22');
  await page.waitForSelector('#t22-result .result-box', { timeout: 60000 });
  ok((await page.textContent('#t22-result .result-title')).trim() === 'TOKEN-2022 BERHASIL DIBUAT', 'TOKEN-2022 BERHASIL DIBUAT');
  ok((await page.textContent('#t22-result .fee-box')).includes('250 bps (2.50%)'), 'fee box 250 bps (2.50%)');
  {
    const c = captured.find((x) => x.label === 't22');
    const tx = Transaction.from(Buffer.from(c.raw, 'base64'));
    ok(tx.verifySignatures() && tx.signatures.length === 2, 'tx token-2022 valid (2 signer)');
    ok(tx.instructions.length === 6, '6 instruksi (5 Token-2022 + metadata Create V1)');
    const [ixCreate, ixFee, ixInit, ixAta, ixMint, ixMeta] = tx.instructions;
    ok(ixMeta.programId.toBase58() === METAPLEX_PROGRAM && ixMeta.data[0] === 42 && ixMeta.keys[8].pubkey.equals(spl.TOKEN_2022_PROGRAM_ID), 'ix6 Metaplex Create V1 untuk Token-2022');
    ok(ixCreate.keys[1].pubkey && Number(ixCreate.data.readBigUInt64LE(12)) === 278, 'space = 278 (mint + TransferFeeConfig)');
    ok(new PublicKey(ixCreate.data.slice(20, 52)).equals(spl.TOKEN_2022_PROGRAM_ID), 'owner akun = Token-2022 program');
    const mintPk = ixCreate.keys[1].pubkey;
    const refFee = spl.createInitializeTransferFeeConfigInstruction(mintPk, testKp.publicKey, testKp.publicKey, 250, 5000000n, spl.TOKEN_2022_PROGRAM_ID);
    ok(Buffer.compare(ixFee.data, refFee.data) === 0 && ixFee.programId.equals(spl.TOKEN_2022_PROGRAM_ID), 'ix2 InitializeTransferFeeConfig identik (sebelum InitializeMint)');
    const refInit = spl.createInitializeMintInstruction(mintPk, 9, testKp.publicKey, null, spl.TOKEN_2022_PROGRAM_ID);
    ok(Buffer.compare(ixInit.data, refInit.data) === 0 && ixInit.programId.equals(spl.TOKEN_2022_PROGRAM_ID), 'ix3 InitializeMint (Token-2022)');
    const ata = spl.getAssociatedTokenAddressSync(mintPk, testKp.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
    ok(ixAta.keys[1].pubkey.equals(ata) && ixAta.keys[5].pubkey.equals(spl.TOKEN_2022_PROGRAM_ID), 'ix4 ATA Token-2022 benar');
    ok(Number(ixMint.data.readBigUInt64LE(1)) === 1000000 * 1e9 && ixMint.programId.equals(spl.TOKEN_2022_PROGRAM_ID), 'ix5 MintTo 1,000,000 × 10^9');
  }
  await page.screenshot({ path: `${SHOTS}/05-token2022.png`, fullPage: true });

  console.log('\n[9] REVOKE AUTHORITY');
  currentLabel = 'revoke';
  await page.click('.tab[data-tab="authority"]');
  ok((await page.textContent('#btn-auth')).trim() === 'REVOKE MINT', 'label REVOKE MINT');
  await page.click('.auth-type[data-type="update"]');
  ok(await page.locator('#btn-auth').isEnabled(), 'update → tombol REVOKE UPDATE aktif (Metaplex terimplementasi)');
  ok(await page.locator('#auth-update-warn').isVisible(), 'peringatan "permanen" tampil');
  ok((await page.textContent('#btn-auth')).trim() === 'REVOKE UPDATE', 'label REVOKE UPDATE');
  ok((await page.inputValue('#auth-type')) === 'update', 'select sinkron dengan tombol');
  await page.selectOption('#auth-type', 'freeze');
  ok((await page.textContent('#btn-auth')).trim() === 'REVOKE FREEZE', 'select → REVOKE FREEZE');
  ok((await page.textContent('#auth-type-desc')).includes('Freeze authority'), 'deskripsi freeze');
  await page.click('.auth-type[data-type="mint"]');
  await page.fill('#auth-mint', USDC_DEV);
  await page.click('#btn-auth');
  await page.waitForSelector('#auth-error .error-box', { timeout: 60000 });
  {
    const err = (await page.textContent('#auth-error .error-box')).trim();
    ok(/Mint authority (bukan wallet ini|token ini sudah tidak ada)/.test(err), 'revoke mint milik orang lain ditolak sebelum kirim tx: ' + err.slice(0, 80));
  }
  await page.selectOption('#auth-type', 'update');
  await page.click('#btn-auth');
  await page.waitForSelector('#auth-error .error-box', { timeout: 60000 });
  {
    const err = (await page.textContent('#auth-error .error-box')).trim();
    ok(/Update authority metadata bukan wallet ini|tidak memiliki metadata/.test(err), 'revoke update authority milik orang lain ditolak: ' + err.slice(0, 80));
  }
  await page.selectOption('#auth-type', 'mint');
  // error path: mint kosong
  await page.fill('#auth-mint', '');
  await page.click('#btn-auth');
  await page.waitForSelector('#auth-error .error-box');
  ok((await page.textContent('#auth-error .error-box')).includes('Mint address required'), 'error "Mint address required"');
  await page.screenshot({ path: `${SHOTS}/06-authority.png`, fullPage: true });

  console.log('\n[10] JUPITER SWAP (quote asli dari lite-api.jup.ag)');
  currentLabel = 'swap';
  await page.click('.tab[data-tab="swap"]');
  ok(await page.locator('#btn-swap').isDisabled(), 'EXECUTE SWAP disabled sebelum quote');
  await page.fill('#form-swap [name=outputMint]', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  await page.fill('#form-swap [name=amount]', '0.01');
  await page.click('#btn-quote');
  await page.waitForSelector('#swap-quote .quote-box, #swap-error .error-box', { timeout: 60000 });
  const hasQuote = (await page.locator('#swap-quote .quote-box').count()) > 0;
  if (hasQuote) {
    ok(true, 'QUOTE DITERIMA: ' + (await page.textContent('#swap-quote .kv-grid')).replace(/\s+/g, ' ').trim());
    ok(await page.locator('#btn-swap').isEnabled(), 'EXECUTE SWAP enabled');
    await page.click('#btn-mainnet'); // swap SOL→USDC adalah mainnet
    await page.click('#btn-swap');
    await page.waitForSelector('#swap-result .result-box, #swap-error .error-box', { timeout: 90000 });
    if ((await page.locator('#swap-result .result-box').count()) > 0) {
      ok(true, 'SWAP BERHASIL (tx ditangkap, tidak dikirim ke chain)');
      const c = captured.find((x) => x.label === 'swap');
      const vtx = VersionedTransaction.deserialize(Buffer.from(c.raw, 'base64'));
      ok(vtx.signatures.length >= 1 && vtx.message.staticAccountKeys[0].equals(testKp.publicKey), 'VersionedTransaction Jupiter: payer = wallet, signature terisi');
      const { ed25519 } = require('@noble/curves/ed25519');
      ok(ed25519.verify(vtx.signatures[0], vtx.message.serialize(), testKp.publicKey.toBytes()), 'tanda tangan versioned tx valid');
    } else {
      console.log('  ⚠ swap error (diharapkan bila wallet kosong):', (await page.textContent('#swap-error .error-box')).trim());
    }
    await page.click('#btn-devnet');
  } else {
    console.log('  ⚠ quote error:', (await page.textContent('#swap-error .error-box')).trim());
  }
  await page.screenshot({ path: `${SHOTS}/07-swap.png`, fullPage: true });

  console.log('\n[11] LIQUIDITY CPMM — lazy load Raydium SDK');
  await page.click('.tab[data-tab="liquidity"]');
  await page.waitForFunction(() => !!window.RaydiumSDK, null, { timeout: 60000 });
  ok(true, 'vendor/raydium-sdk.js dimuat lazy saat tab dibuka');
  await page.waitForFunction(() => { const t = document.getElementById('liq-sdk-status').textContent; return t.includes('siap') || t.includes('error'); }, null, { timeout: 120000 });
  const sdkStatus = (await page.textContent('#liq-sdk-status')).trim();
  console.log('  SDK status:', sdkStatus);
  ok(await page.locator('#btn-liq-create').isDisabled(), 'CREATE POOL disabled tanpa input');
  await page.fill('#liq-mintA', createdMint);
  await page.fill('#liq-mintB', 'So11111111111111111111111111111111111111112');
  await page.fill('#liq-priceA', '1');
  await page.fill('#liq-amountA', '100');
  ok(await page.locator('#btn-liq-create').isEnabled(), 'CREATE POOL enabled setelah input lengkap');
  await page.click('#btn-liq-create');
  await page.waitForSelector('#liq-result .result-box, #liq-error .error-box', { timeout: 60000 });
  const liqOut = (await page.textContent('#liq-result, #liq-error')).trim();
  console.log('  CREATE POOL →', liqOut.slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/08-liquidity.png`, fullPage: true });

  console.log('\n[12] LIQUIDITY CLMM');
  await page.click('.tab[data-tab="clmm"]');
  await page.fill('#clmm-mintA', createdMint);
  await page.fill('#clmm-amountA', '1000');
  await page.fill('#clmm-amountB', '10');
  ok(await page.locator('#btn-clmm-create').isEnabled(), 'CREATE CLMM POOL enabled');
  await page.click('#btn-clmm-create');
  await page.waitForSelector('#clmm-result .result-box, #clmm-error .error-box', { timeout: 60000 });
  console.log('  CREATE CLMM POOL →', (await page.textContent('#clmm-result, #clmm-error')).trim().slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/09-clmm.png`, fullPage: true });

  console.log('\n[13] COPY, WIPE ALL, DISCONNECT');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.tab[data-tab="list"]');
  await page.click('#token-list [data-copy]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(clip.length > 30, '[COPY] menyalin mint ke clipboard: ' + clip.slice(0, 8) + '…');
  await page.click('#btn-wipe');
  ok((await page.textContent('#token-list')).includes('Belum ada token'), 'WIPE ALL → list kosong');
  ok((await page.evaluate(() => localStorage.getItem('token-creator-tokens'))) === null, 'localStorage dihapus');
  await page.click('#btn-disconnect');
  await page.waitForSelector('#btn-connect');
  ok((await page.textContent('#status-addr')).trim() === 'DISCONNECTED', 'DISCONNECTED setelah disconnect');
  ok(await page.locator('#btn-create').isDisabled(), 'LAUNCH disabled lagi');

  console.log('\n[14] Tanpa wallet terpasang');
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page2.goto(BASE, { waitUntil: 'load' });
  await page2.click('#btn-connect');
  await page2.waitForSelector('.connect-error');
  ok((await page2.textContent('.connect-error')).trim() === 'No wallet adapter available', 'error "No wallet adapter available"');
  ok((await page2.locator('.wallet-menu a.not-installed').count()) === 2, 'menu install Phantom & Solflare tampil');
  await page2.screenshot({ path: `${SHOTS}/10-no-wallet.png` });
  // mobile viewport
  await page2.setViewportSize({ width: 390, height: 844 });
  await page2.screenshot({ path: `${SHOTS}/11-mobile.png`, fullPage: true });

  console.log('\nConsole errors:', consoleErrors.length ? consoleErrors : 'tidak ada');
  console.log(`\nTransaksi tertangkap: ${captured.length} (${captured.map((c) => c.label).join(', ')})`);
  console.log('\n✅ SEMUA E2E LULUS');
  await browser.close();
})().catch(async (e) => {
  console.error('\n❌', e.message);
  console.error('Console errors:', consoleErrors);
  process.exit(1);
});

/**
 * E2E "nyata" SOLLAUNCHPAD lite — Playwright + Chromium headless + solana-test-validator.
 *
 * Semua transaksi benar-benar dikirim & dikonfirmasi di validator lokal yang meng-clone program
 * Raydium CPMM/CLMM devnet + Metaplex Token Metadata, lalu hasilnya diverifikasi langsung on-chain.
 *
 * Persiapan (terminal 1):
 *   solana-test-validator --reset --url https://api.devnet.solana.com \
 *     --clone-upgradeable-program DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb \
 *     --clone-upgradeable-program DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH \
 *     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
 *     --clone 3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy \
 *     --clone 5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy --clone HTVWgp8CbUsRNmRE1p9RBYqopxe2qiyApSkiTFLrfxaW \
 *     --clone A9qBhPy4k5UYW72hSgAkh1Epr2do69P54yzzcMV3yv6b --clone EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz \
 *     --clone 5Gt9qrPJ6FVe9VHtwF2W2JrFR6p9jmx4DxBkgfPdaApk \
 *     --clone CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu --clone F8aaMZVpXaQHk3Qo9BPDhsa7RgpfrfiRsk8L3iXnq3AT \
 *     --clone FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q
 *
 * Jalankan (terminal 2):
 *   npm install && npm i -D playwright && npx playwright install chromium
 *   node scripts/e2e-localnet.js            (server uji dijalankan otomatis di port 3001 dengan RPC_DEVNET=localnet)
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8899';
const PORT = process.env.E2E_PORT || '3001';
const BASE = `http://localhost:${PORT}`;
const WSOL = 'So11111111111111111111111111111111111111112';
const SHOTS = path.join(os.tmpdir(), 'sollaunchpad-e2e-localnet');
fs.mkdirSync(SHOTS, { recursive: true });

// Modul browser dipakai ulang di Node untuk membaca metadata on-chain
globalThis.window = globalThis;
globalThis.solanaWeb3 = require('@solana/web3.js');
require('../public/js/metaplex.js');
const Metaplex = globalThis.Metaplex;

const testKp = Keypair.generate();
const feeRecipient = Keypair.generate().publicKey;
const connection = new Connection(RPC, 'confirmed');
const consoleErrors = [];
let passed = 0;
function ok(cond, msg) { if (!cond) throw new Error('ASSERT FAIL: ' + msg); passed++; console.log('  ✔', msg); }
const text = async (page, sel) => ((await page.textContent(sel)) || '').trim();
const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** Jalankan server statis khusus uji dengan RPC devnet dialihkan ke validator lokal */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT, RPC_DEVNET: RPC },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (/http:\/\//.test(out)) resolve(child); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error('server exit ' + code + '\n' + out)));
    setTimeout(() => resolve(child), 3000);
  });
}

/** Tunggu hasil / error pada sepasang kontainer, kembalikan {result, error} */
async function waitOutcome(page, resultSel, errorSel, timeout) {
  await page.waitForSelector(`${resultSel} .result-box, ${errorSel} .error-box`, { timeout: timeout || 90000 });
  const result = (await page.locator(`${resultSel} .result-box`).count()) ? await text(page, `${resultSel} .result-box`) : '';
  const error = (await page.locator(`${errorSel} .error-box`).count()) ? await text(page, `${errorSel} .error-box`) : '';
  return { result, error };
}

/** Parse TLV TransferFeeConfig (type 1) dari data mint Token-2022 */
function parseTransferFee(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 166;
  while (off + 4 <= data.length) {
    const type = dv.getUint16(off, true);
    const len = dv.getUint16(off + 2, true);
    const start = off + 4;
    if (type === 1) {
      return {
        withdrawWithheldAuthority: new PublicKey(data.slice(start + 32, start + 64)).toBase58(),
        maximumFee: dv.getBigUint64(start + 98, true),
        basisPoints: dv.getUint16(start + 106, true),
      };
    }
    off = start + len;
  }
  return null;
}

(async () => {
  const slot = await connection.getSlot().catch(() => null);
  if (slot == null) throw new Error(`Validator lokal tidak terjangkau di ${RPC}`);
  console.log(`Validator lokal slot ${slot} | wallet uji ${testKp.publicKey.toBase58()} | screenshot → ${SHOTS}`);
  const air = await connection.requestAirdrop(testKp.publicKey, 100e9);
  await connection.confirmTransaction(air, 'confirmed');

  const server = await startServer();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
          if (typeof tx.version === 'number') tx.sign([this._kp]);
          else tx.partialSign(this._kp);
          return tx;
        },
        async signAllTransactions(txs) {
          for (const tx of txs) await this.signTransaction(tx);
          return txs;
        },
      };
      window.phantom = { solana: provider };
    }, Array.from(testKp.secretKey));

    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

    console.log('\n[1] Load + connect (RPC devnet → validator lokal)');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.solanaWeb3 && window.SplToken && window.Wallet && window.Metaplex);
    ok((await page.evaluate(() => window.APP_CONFIG.RPC_URLS.devnet)) === RPC, 'config.js memakai RPC_DEVNET dari env: ' + RPC);
    await page.click('#btn-connect');
    await page.waitForSelector('#btn-disconnect');
    ok(await page.locator('#btn-create').isEnabled(), 'wallet terhubung, LAUNCH enabled');

    console.log('\n[2] CREATE TOKEN + metadata Metaplex (on-chain)');
    await page.fill('#form-create [name=name]', 'Local Test Token');
    await page.fill('#form-create [name=symbol]', 'LTT');
    await page.fill('#form-create [name=decimals]', '6');
    await page.fill('#form-create [name=initialSupply]', '1000000');
    await page.fill('#form-create [name=metadataUri]', 'https://example.com/ltt.json');
    await page.click('#btn-create');
    let o = await waitOutcome(page, '#create-result', '#create-error');
    ok(!o.error && /TOKEN BERHASIL DIBUAT/.test(o.result), 'TOKEN BERHASIL DIBUAT ' + o.error);
    const createdMint = await text(page, '#create-result .result-val.green');
    ok(b58.test(createdMint), 'mint: ' + createdMint);
    {
      const mint = await spl.getMint(connection, new PublicKey(createdMint));
      ok(mint.decimals === 6 && mint.supply === 1000000n * 10n ** 6n, 'on-chain: decimals 6, supply 1.000.000');
      ok(mint.mintAuthority && mint.mintAuthority.equals(testKp.publicKey), 'mint authority = wallet');
      const meta = await Metaplex.getMetadata(connection, new PublicKey(createdMint));
      ok(meta && meta.name === 'Local Test Token' && meta.symbol === 'LTT' && meta.uri === 'https://example.com/ltt.json', 'metadata Metaplex on-chain: nama/symbol/URI benar');
      ok(meta.isMutable === true && meta.updateAuthority === testKp.publicKey.toBase58(), 'metadata mutable, update authority = wallet');
    }
    await page.screenshot({ path: `${SHOTS}/01-create.png`, fullPage: true });

    console.log('\n[2b] PAKAI TOKEN INI DI: → POOL CPMM / → POOL CLMM / → REVOKE AUTHORITY');
    ok((await page.locator('#create-result [data-use-pool]').count()) === 2, 'kotak hasil punya tombol → POOL CPMM & → POOL CLMM');
    await page.click('#create-result [data-use-pool="cpmm"]');
    ok(await page.locator('[data-panel="liquidity"]').evaluate((e) => e.classList.contains('active')), 'pindah ke tab LIQUIDITY CPMM');
    ok((await page.inputValue('#liq-mintA')) === createdMint, 'MINT A CPMM terisi mint baru');
    ok((await page.inputValue('#liq-mintB')) === WSOL, 'MINT B default WSOL');
    ok(await page.locator('#liq-prefill-note').isVisible() && /MINT A diisi/.test(await text(page, '#liq-prefill-note')), 'catatan pengisian tampil');
    await page.click('.tab[data-tab="create"]');
    await page.click('#create-result [data-use-pool="clmm"]');
    ok(await page.locator('[data-panel="clmm"]').evaluate((e) => e.classList.contains('active')), 'pindah ke tab LIQUIDITY CLMM');
    ok((await page.inputValue('#clmm-mintA')) === createdMint && (await page.inputValue('#clmm-decimalsA')) === '6', 'MINT A CLMM + DECIMALS A (6) terisi');
    await page.click('.tab[data-tab="create"]');
    await page.click('#create-result [data-use-auth]');
    ok(await page.locator('[data-panel="authority"]').evaluate((e) => e.classList.contains('active')) && (await page.inputValue('#auth-mint')) === createdMint, '→ REVOKE AUTHORITY mengisi mint & pindah tab');
    await page.screenshot({ path: `${SHOTS}/01b-use-token.png`, fullPage: true });
    await page.evaluate(() => ['liq-mintA', 'liq-mintB', 'clmm-mintA', 'auth-mint'].forEach((id) => { document.getElementById(id).value = ''; }));

    console.log('\n[3] CLONE TOKEN — baca metadata sumber & clone');
    await page.click('.tab[data-tab="clone"]');
    await page.fill('#clone-input', createdMint);
    await page.click('#btn-clone-fetch');
    await page.waitForSelector('#clone-data .source-box', { timeout: 60000 });
    const srcBox = await text(page, '#clone-data .source-box');
    ok(/NAMA \(METADATA\)/.test(srcBox) && /Local Test Token/.test(srcBox) && /LTT/.test(srcBox), 'kotak sumber menampilkan NAMA (METADATA) + SYMBOL dari Metaplex');
    ok((await page.inputValue('#form-clone [name=name]')) === 'Local Test Token', 'form clone nama dari metadata');
    ok((await page.inputValue('#form-clone [name=symbol]')) === 'LTT', 'form clone symbol dari metadata');
    ok((await page.inputValue('#form-clone [name=decimals]')) === '6', 'form clone decimals 6');
    ok((await page.inputValue('#form-clone [name=initialSupply]')) === '1000000', 'form clone supply 1000000');
    await page.fill('#form-clone [name=initialSupply]', '500');
    await page.click('#btn-clone');
    o = await waitOutcome(page, '#clone-result', '#clone-error');
    ok(!o.error && /CLONE BERHASIL DIBUAT/.test(o.result), 'CLONE BERHASIL DIBUAT ' + o.error);
    const clonedMint = await text(page, '#clone-result .result-val.green');
    {
      const mint = await spl.getMint(connection, new PublicKey(clonedMint));
      ok(mint.decimals === 6 && mint.supply === 500n * 10n ** 6n, 'clone on-chain: decimals 6, supply 500');
      const meta = await Metaplex.getMetadata(connection, new PublicKey(clonedMint));
      ok(meta && meta.name === 'Local Test Token' && meta.symbol === 'LTT' && meta.uri === 'https://example.com/ltt.json', 'metadata clone (nama/symbol/URI) ikut ter-clone');
    }
    await page.click('.tab[data-tab="list"]');
    ok((await page.locator('#token-list tbody tr').count()) === 2, 'token list 2 baris');
    await page.screenshot({ path: `${SHOTS}/02-clone.png`, fullPage: true });

    console.log('\n[4] TOKEN-2022 transfer fee + metadata');
    await page.click('.tab[data-tab="token2022"]');
    await page.fill('#form-t22 [name=name]', 'Fee Token');
    await page.fill('#form-t22 [name=symbol]', 'FEE');
    await page.fill('#form-t22 [name=transferFeeBasisPoints]', '250');
    await page.fill('#form-t22 [name=transferFeeMax]', '0');
    await page.fill('#form-t22 [name=feeRecipient]', feeRecipient.toBase58());
    await page.click('#btn-t22');
    o = await waitOutcome(page, '#t22-result', '#t22-error');
    ok(!o.error && /TOKEN-2022 BERHASIL DIBUAT/.test(o.result), 'TOKEN-2022 BERHASIL DIBUAT ' + o.error);
    ok(/250 bps \(2\.50%\)/.test(o.result), 'fee box 250 bps (2.50%)');
    const t22Mint = await text(page, '#t22-result .result-val.green');
    {
      const info = await connection.getAccountInfo(new PublicKey(t22Mint));
      ok(info.owner.equals(spl.TOKEN_2022_PROGRAM_ID), 'mint dimiliki program Token-2022');
      const fee = parseTransferFee(info.data);
      ok(fee && fee.basisPoints === 250, 'TransferFeeConfig bps = 250');
      ok(fee.maximumFee === 18446744073709551615n, 'MAX FEE 0 → tanpa cap (u64 max)');
      ok(fee.withdrawWithheldAuthority === feeRecipient.toBase58(), 'withdraw-withheld authority = FEE RECIPIENT');
      const ata = spl.getAssociatedTokenAddressSync(new PublicKey(t22Mint), testKp.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
      const bal = await connection.getTokenAccountBalance(ata);
      ok(bal.value.uiAmount === 1000000, 'supply 1.000.000 di ATA creator');
      const meta = await Metaplex.getMetadata(connection, new PublicKey(t22Mint));
      ok(meta && meta.name === 'Fee Token' && meta.symbol === 'FEE', 'metadata Metaplex (Create V1) untuk Token-2022');
    }
    await page.screenshot({ path: `${SHOTS}/03-token2022.png`, fullPage: true });

    console.log('\n[4b] KLAIM FEE — bukan authority → ditolak; token kedua (recipient = wallet) → klaim sukses');
    ok((await page.inputValue('#claim-mint')) === t22Mint, 'kartu klaim otomatis terisi mint Token-2022 baru');
    await page.click('#t22-result [data-use-claim]');
    await page.waitForFunction(() => /TOTAL BISA DIKLAIM/.test(document.getElementById('claim-info').textContent), null, { timeout: 60000 });
    let ci = await text(page, '#claim-info');
    ok(/250 bps \(2\.50%\)/.test(ci) && /tanpa cap/.test(ci), 'CEK FEE: 250 bps, max fee tanpa cap');
    ok(/bukan wallet ini/.test(ci), 'CEK FEE: withdraw authority ≠ wallet (ditandai ✘)');
    ok(/TOTAL BISA DIKLAIM: 0/.test(ci), 'belum ada fee tertahan (0)');
    await page.click('#btn-claim');
    await page.waitForSelector('#claim-error .error-box', { timeout: 60000 });
    ok(/bukan FEE RECIPIENT/.test(await text(page, '#claim-error .error-box')), 'CLAIM FEE oleh bukan-authority ditolak: ' + (await text(page, '#claim-error .error-box')).slice(0, 60));
    // Token-2022 kedua: FEE RECIPIENT kosong = wallet yang connect
    await page.fill('#form-t22 [name=name]', 'Claim Token');
    await page.fill('#form-t22 [name=symbol]', 'CLM');
    await page.fill('#form-t22 [name=decimals]', '6');
    await page.fill('#form-t22 [name=transferFeeBasisPoints]', '500');
    await page.fill('#form-t22 [name=transferFeeMax]', '0');
    await page.fill('#form-t22 [name=feeRecipient]', '');
    await page.click('#btn-t22');
    o = await waitOutcome(page, '#t22-result', '#t22-error');
    ok(!o.error && /TOKEN-2022 BERHASIL DIBUAT/.test(o.result), 'token kedua dibuat ' + o.error);
    const t22Mint2 = await text(page, '#t22-result .result-val.green');
    {
      // Hasilkan fee tertahan: transfer ke 2 akun lain dari Node (wallet uji menandatangani)
      const m = new PublicKey(t22Mint2);
      const src = spl.getAssociatedTokenAddressSync(m, testKp.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
      const tx = new (require('@solana/web3.js').Transaction)();
      for (let i = 0; i < 2; i++) {
        const owner = Keypair.generate().publicKey;
        const dst = spl.getAssociatedTokenAddressSync(m, owner, false, spl.TOKEN_2022_PROGRAM_ID);
        tx.add(
          spl.createAssociatedTokenAccountInstruction(testKp.publicKey, dst, owner, m, spl.TOKEN_2022_PROGRAM_ID),
          spl.createTransferCheckedInstruction(src, m, dst, testKp.publicKey, 1000n * 10n ** 6n, 6, [], spl.TOKEN_2022_PROGRAM_ID)
        );
      }
      await require('@solana/web3.js').sendAndConfirmTransaction(connection, tx, [testKp]);
    }
    const balBefore = (await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(new PublicKey(t22Mint2), testKp.publicKey, false, spl.TOKEN_2022_PROGRAM_ID))).value.amount;
    await page.click('#t22-result [data-use-claim]');
    await page.waitForFunction(() => /TOTAL BISA DIKLAIM: 100/.test(document.getElementById('claim-info').textContent), null, { timeout: 60000 });
    ci = await text(page, '#claim-info');
    ok(/wallet ini ✔/.test(ci), 'CEK FEE: wallet = withdraw authority ✔');
    ok(/Tertahan di 2 akun: 100/.test(ci) && /TOTAL BISA DIKLAIM: 100/.test(ci), '2 akun × 50 (5% dari 1000) = 100 tertahan');
    await page.click('#btn-claim');
    o = await waitOutcome(page, '#claim-result', '#claim-error', 90000);
    ok(!o.error && /FEE BERHASIL DIKLAIM/.test(o.result) && /100 token ditarik dari 2 akun/.test(o.result), 'CLAIM FEE sukses: ' + o.error);
    {
      const ata = spl.getAssociatedTokenAddressSync(new PublicKey(t22Mint2), testKp.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
      const balAfter = (await connection.getTokenAccountBalance(ata)).value.amount;
      ok(BigInt(balAfter) - BigInt(balBefore) === 100n * 10n ** 6n, 'on-chain: saldo wallet bertambah tepat 100 token');
    }
    await page.waitForFunction(() => /TOTAL BISA DIKLAIM: 0/.test(document.getElementById('claim-info').textContent), null, { timeout: 60000 });
    ok(true, 'pindai ulang setelah klaim: 0 tersisa');
    await page.screenshot({ path: `${SHOTS}/03b-claim.png`, fullPage: true });

    console.log('\n[5] REVOKE AUTHORITY (mint / freeze / update)');
    await page.click('.tab[data-tab="authority"]');
    await page.fill('#auth-mint', createdMint);
    await page.click('.auth-type[data-type="update"]');
    ok(await page.locator('#btn-auth').isEnabled(), 'REVOKE UPDATE enabled (bukan "coming soon")');
    ok(/permanen/.test(await text(page, '#auth-update-warn')), 'peringatan update authority informatif');
    await page.click('#btn-auth');
    o = await waitOutcome(page, '#auth-result', '#auth-error');
    ok(!o.error && /AUTHORITY REVOKED/.test(o.result), 'update authority dicabut ' + o.error);
    {
      const meta = await Metaplex.getMetadata(connection, new PublicKey(createdMint));
      ok(meta.isMutable === false, 'on-chain: metadata isMutable = false');
    }
    await page.click('#btn-auth');
    o = await waitOutcome(page, '#auth-result', '#auth-error');
    ok(/sudah immutable/.test(o.error), 'revoke update kedua ditolak: ' + o.error);
    await page.click('.auth-type[data-type="freeze"]');
    await page.click('#btn-auth');
    o = await waitOutcome(page, '#auth-result', '#auth-error');
    ok(/Freeze authority token ini sudah tidak ada/.test(o.error), 'freeze (tidak pernah diset) → pesan jelas');
    await page.click('.auth-type[data-type="mint"]');
    await page.click('#btn-auth');
    o = await waitOutcome(page, '#auth-result', '#auth-error');
    ok(!o.error && /AUTHORITY REVOKED/.test(o.result), 'mint authority dicabut ' + o.error);
    {
      const mint = await spl.getMint(connection, new PublicKey(createdMint));
      ok(mint.mintAuthority === null, 'on-chain: mint authority = null');
    }
    await page.click('#btn-auth');
    o = await waitOutcome(page, '#auth-result', '#auth-error');
    ok(/Mint authority token ini sudah tidak ada/.test(o.error), 'revoke mint kedua ditolak dengan pesan jelas');
    await page.screenshot({ path: `${SHOTS}/04-authority.png`, fullPage: true });

    console.log('\n[6] RAYDIUM CPMM — create pool / add / remove (SDK asli, program devnet ter-clone)');
    await page.click('.tab[data-tab="liquidity"]');
    await page.waitForFunction(() => /siap/.test(document.getElementById('liq-sdk-status').textContent), null, { timeout: 120000 });
    ok(true, 'Raydium SDK dimuat lazy & siap: ' + (await text(page, '#liq-sdk-status')));
    await page.fill('#liq-mintA', clonedMint);
    await page.fill('#liq-mintB', WSOL);
    await page.fill('#liq-priceA', '0.5');
    await page.click('#btn-liq-create');
    o = await waitOutcome(page, '#liq-result', '#liq-error');
    ok(/Isi AMOUNT A/.test(o.error), 'CREATE POOL tanpa jumlah → pesan jelas: ' + o.error);
    await page.fill('#liq-amountA', '100');
    await page.click('#btn-liq-create');
    o = await waitOutcome(page, '#liq-result', '#liq-error', 150000);
    ok(!o.error && /CPMM pool created/.test(o.result), 'CPMM pool created ' + o.error);
    ok(/Likuiditas awal: 100 A \+ 50 B/.test(o.result), 'detail: 100 A + 50 B (harga 0.5)');
    const poolId = (o.result.match(/Pool: ([1-9A-HJ-NP-Za-km-z]{32,44})/) || [])[1];
    ok(!!poolId, 'pool id: ' + poolId);
    {
      const acc = await connection.getAccountInfo(new PublicKey(poolId));
      ok(acc && acc.owner.toBase58() === 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb', 'akun pool on-chain milik program CPMM devnet');
    }
    await page.fill('#liq-poolId', poolId);
    await page.fill('#liq-amountA', '10');
    await page.fill('#liq-amountB', '1');
    await page.click('#btn-liq-deposit');
    o = await waitOutcome(page, '#liq-result', '#liq-error', 150000);
    ok(/AMOUNT B tidak cukup/.test(o.error), 'ADD dengan AMOUNT B kurang ditolak: ' + o.error);
    await page.fill('#liq-amountB', '5.1');
    await page.click('#btn-liq-deposit');
    o = await waitOutcome(page, '#liq-result', '#liq-error', 150000);
    ok(!o.error && /Liquidity added/.test(o.result), 'Liquidity added ' + o.error);
    ok(/Disetor ≈ 10 A \+ 5 B/.test(o.result), 'detail deposit: 10 A + 5 B (orientasi mengikuti MINT A form)');
    await page.fill('#liq-liquidity', '1');
    await page.click('#btn-liq-withdraw');
    o = await waitOutcome(page, '#liq-result', '#liq-error', 150000);
    ok(!o.error && /Liquidity removed/.test(o.result), 'Liquidity removed ' + o.error);
    ok(/Estimasi diterima ≈ [\d.]+ A \+ [\d.]+ B/.test(o.result), 'detail withdraw menampilkan estimasi A/B');
    await page.screenshot({ path: `${SHOTS}/05-cpmm.png`, fullPage: true });

    console.log('\n[7] RAYDIUM CLMM — create pool + posisi, add liquidity');
    await page.click('.tab[data-tab="clmm"]');
    await page.fill('#clmm-mintA', clonedMint);
    await page.fill('#clmm-mintB', WSOL);
    await page.fill('#clmm-decimalsA', '6');
    await page.fill('#clmm-decimalsB', '9');
    await page.fill('#clmm-initialPrice', '1');
    await page.fill('#clmm-priceLower', '0.8');
    await page.fill('#clmm-priceUpper', '1.2');
    await page.selectOption('#clmm-feeRate', '25');
    await page.fill('#clmm-amountA', '10');
    await page.click('#btn-clmm-create');
    o = await waitOutcome(page, '#clmm-result', '#clmm-error', 180000);
    ok(!o.error && /CLMM pool created/.test(o.result), 'CLMM pool created ' + o.error);
    ok(/Posisi likuiditas dibuka: 10 A \+ [\d.]+ B/.test(o.result), 'posisi awal dibuka dengan 10 A');
    ok(/Trade fee 0\.05%/.test(o.result), 'fee 0.05% (config devnet 500)');
    const clmmPool = (o.result.match(/Pool ID: ([1-9A-HJ-NP-Za-km-z]{32,44})/) || [])[1];
    ok(!!clmmPool, 'CLMM pool id: ' + clmmPool);
    ok(/Tick Range: -?\d+ – -?\d+/.test(o.result), 'tick range ditampilkan');
    ok(/LIHAT TRANSAKSI POSISI/.test(o.result), 'link transaksi posisi');
    {
      const acc = await connection.getAccountInfo(new PublicKey(clmmPool));
      ok(acc && acc.owner.toBase58() === 'DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH', 'akun pool on-chain milik program CLMM devnet');
    }
    ok(/Pool ID terbaru/.test(await text(page, '#clmm-latest-pool')), 'Pool ID terbaru ditampilkan');
    await page.fill('#clmm-poolId', clmmPool);
    await page.fill('#clmm-priceLower', '0.9');
    await page.fill('#clmm-priceUpper', '1.1');
    await page.fill('#clmm-amountA', '5');
    await page.fill('#clmm-amountB', '0.001');
    await page.click('#btn-clmm-deposit');
    o = await waitOutcome(page, '#clmm-result', '#clmm-error', 150000);
    ok(/AMOUNT B tidak cukup/.test(o.error), 'ADD CLMM dengan AMOUNT B kurang ditolak: ' + o.error);
    await page.fill('#clmm-amountB', '');
    await page.click('#btn-clmm-deposit');
    o = await waitOutcome(page, '#clmm-result', '#clmm-error', 150000);
    ok(!o.error && /CLMM liquidity added/.test(o.result), 'CLMM liquidity added ' + o.error);
    ok(/Posisi: 5 A \+ [\d.]+ B pada rentang 0\.9 – 1\.1/.test(o.result), 'detail posisi baru 5 A pada rentang 0.9 – 1.1');
    await page.screenshot({ path: `${SHOTS}/06-clmm.png`, fullPage: true });

    console.log('\n[8] Saldo & bersih-bersih');
    const bal = await connection.getBalance(testKp.publicKey);
    ok(bal < 100e9 && bal > 0, `saldo wallet uji sekarang ${(bal / 1e9).toFixed(3)} SOL (biaya pool + likuiditas terpakai)`);
    await page.click('#btn-disconnect');
    await page.waitForSelector('#btn-connect');
    ok((await text(page, '#status-addr')) === 'DISCONNECTED', 'disconnect OK');

    const realErrors = consoleErrors.filter((e) => !/favicon/.test(e));
    console.log('\nConsole errors:', realErrors.length ? realErrors : 'tidak ada');
    console.log(`\n✅ SEMUA E2E LOCALNET LULUS (${passed} pemeriksaan)`);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});

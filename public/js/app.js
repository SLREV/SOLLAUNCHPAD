/**
 * app.js — SOLLAUNCHPAD dashboard (vanilla JS)
 * Port 1:1 dari components/TokenDashboard.tsx, AuthorityRevoker.tsx,
 * ConnectButton.tsx dan WalletProvider.tsx (Next.js) tanpa React/Tailwind.
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const web3 = window.solanaWeb3;
  const SplToken = window.SplToken;
  const Wallet = window.Wallet;
  const Metaplex = window.Metaplex;
  const { Connection, PublicKey, Transaction, SystemProgram, Keypair, VersionedTransaction } = web3;

  /* ==================== CONFIG ==================== */
  const RPC_URLS = CFG.RPC_URLS;
  const WRAPPED_SOL = CFG.WRAPPED_SOL;
  const NATIVE_SOL = CFG.NATIVE_SOL;
  const JUPITER_API = CFG.JUPITER_API;

  /* ==================== STATE ==================== */
  const S = {
    network: 'devnet',
    tab: 'create',
    tokens: [],

    raydiumCpmm: null,
    raydiumClmm: null,
    raydiumKey: null,
    raydiumLoading: false,
    raydiumError: '',
    token2022Manager: null,

    connectError: null,
    walletMenuOpen: false,

    createLoading: false, createResult: null, createError: '',
    cloneFetching: false, cloneData: null, cloneLoading: false, cloneResult: null, cloneError: '',
    swapQuoting: false, swapLoading: false, swapQuote: null, swapResult: null, swapError: '',
    liqLoading: false, liqResult: null, liqError: '',
    clmmLoading: false, clmmResult: null, clmmError: '',
    t22Loading: false, t22Result: null, t22Error: '',
    claimChecking: false, claimLoading: false, claimScan: null, claimResult: null, claimError: '',
    authorityType: 'mint', authLoading: false, authResult: null, authError: '',
  };

  /* ==================== DOM HELPERS ==================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (v) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const setHTML = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html || ''; };
  const formValues = (id) => Object.fromEntries(new FormData(document.getElementById(id)).entries());
  const val = (id) => (document.getElementById(id) ? document.getElementById(id).value : '');

  const cluster = () => (S.network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet');
  const isDevnet = () => S.network === 'devnet';
  const getConnection = () => new Connection(RPC_URLS[S.network], 'confirmed');
  const shortAddr = (pk) => { const a = pk.toString(); return a.slice(0, 4) + '...' + a.slice(-4); };
  const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const errorBox = (msg, extraCls) => (msg ? `<div class="error-box ${extraCls || ''}">${esc(msg)}</div>` : '');
  const txLink = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster()}`;

  async function confirmTx(connection, signature, blockhash, lastValidBlockHeight) {
    if (blockhash && lastValidBlockHeight) {
      return connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    }
    return connection.confirmTransaction(signature, 'confirmed');
  }

  /* ==================== TOKEN LIST STORAGE ==================== */
  function loadTokens() {
    const saved = localStorage.getItem(CFG.STORAGE_TOKENS);
    if (saved) {
      try { S.tokens = JSON.parse(saved); } catch (_) { /* ignore */ }
    }
  }
  function saveTokens(next) {
    S.tokens = next;
    localStorage.setItem(CFG.STORAGE_TOKENS, JSON.stringify(next));
    renderList();
  }

  /* ==================== COPY HELPER ==================== */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  /* ==================== DEX LINKS HELPER ==================== */
  function dexLinks(mint) {
    const wsol = WRAPPED_SOL;
    return [
      { label: 'DEXSCREENER', url: `https://dexscreener.com/solana/${mint}`, cls: 'c-blue' },
      { label: 'BIRDEYE', url: `https://birdeye.so/token/${mint}?chain=solana`, cls: 'c-orange' },
      { label: 'RAYDIUM SWAP', url: `https://raydium.io/swap/?inputCurrency=${wsol}&outputCurrency=${mint}`, cls: 'c-green' },
      { label: 'JUPITER SWAP', url: `https://jup.ag/swap/SOL-${mint}`, cls: 'c-pink' },
      { label: 'EXPLORER', url: `https://explorer.solana.com/address/${mint}?cluster=${cluster()}`, cls: 'c-cyan' },
    ];
  }
  const dexChips = (mint) =>
    dexLinks(mint)
      .map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" class="chip chip-sm ${d.cls}">${d.label}</a>`)
      .join('');

  /** Baris aksi lanjutan: pakai mint ini di pool / revoke / klaim fee (roadmap: create → authority → pool) */
  function useTokenRow(mint, opts) {
    const o = opts || {};
    const dec = o.decimals != null ? ` data-decimals="${esc(o.decimals)}"` : '';
    return `
      <div class="use-row mono">
        <span class="result-label">PAKAI TOKEN INI DI:</span>
        <button type="button" class="chip chip-sm use c-green" data-use-pool="cpmm" data-mint="${esc(mint)}"${dec}>→ POOL CPMM</button>
        <button type="button" class="chip chip-sm use c-orange" data-use-pool="clmm" data-mint="${esc(mint)}"${dec}>→ POOL CLMM</button>
        <button type="button" class="chip chip-sm use c-purple" data-use-auth="${esc(mint)}">→ REVOKE AUTHORITY</button>
        ${o.token2022 ? `<button type="button" class="chip chip-sm use c-pink" data-use-claim="${esc(mint)}">→ KLAIM FEE</button>` : ''}
      </div>`;
  }

  function tokenResultBox(title, mintLabel, result, extraHtml) {
    return `
      <div class="result-box">
        <h3 class="result-title">${title}</h3>
        <div class="result-cols">
          <div>
            <p class="result-label">${mintLabel}</p>
            <div class="mint-row">
              <span class="result-val green truncate">${esc(result.mint)}</span>
              <button type="button" class="copy-btn" data-copy="${esc(result.mint)}">[COPY]</button>
            </div>
          </div>
          <div>
            <p class="result-label">SIGNATURE</p>
            <span class="result-val cyan truncate">${esc(result.signature)}</span>
          </div>
        </div>
        ${extraHtml || ''}
        <div class="dex-row">${dexChips(result.mint)}</div>
        ${useTokenRow(result.mint, { decimals: result.decimals, token2022: !!result.token2022 })}
      </div>`;
  }

  /**
   * Isi otomatis form pool/authority/klaim dengan mint hasil create/clone/token-2022, lalu pindah tab.
   * @param {'cpmm'|'clmm'|'auth'|'claim'} target
   */
  function useToken(target, mint, decimals) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const note = (id, msg) => { const el = document.getElementById(id); if (el) { el.textContent = msg; el.hidden = false; } };
    const dec = decimals != null && decimals !== '' ? String(decimals) : '';
    if (target === 'cpmm') {
      setVal('liq-mintA', mint);
      if (!val('liq-mintB')) setVal('liq-mintB', WRAPPED_SOL);
      note('liq-prefill-note', `MINT A diisi dengan ${mint}. Pasangan default: WSOL. Isi PRICE A (harga 1 token dalam B) dan AMOUNT A sebagai likuiditas awal, lalu CREATE POOL.`);
      S.tab = 'liquidity';
    } else if (target === 'clmm') {
      setVal('clmm-mintA', mint);
      if (dec) setVal('clmm-decimalsA', dec);
      if (!val('clmm-mintB')) { setVal('clmm-mintB', WRAPPED_SOL); setVal('clmm-decimalsB', '9'); }
      note('clmm-prefill-note', `MINT A diisi dengan ${mint}${dec ? ` (decimals ${dec})` : ''}. Tentukan HARGA AWAL, rentang harga, fee tier, dan AMOUNT A untuk posisi awal, lalu CREATE CLMM POOL.`);
      S.tab = 'clmm';
    } else if (target === 'auth') {
      setVal('auth-mint', mint);
      S.tab = 'authority';
    } else if (target === 'claim') {
      setVal('claim-mint', mint);
      S.claimScan = null; S.claimResult = null; S.claimError = '';
      S.tab = 'token2022';
      renderClaim();
    }
    renderTabs();
    syncRaydium();
    renderButtons();
    const focusId = { cpmm: 'liq-priceA', clmm: 'clmm-initialPrice', auth: 'auth-type', claim: 'btn-claim-check' }[target];
    const el = document.getElementById(focusId);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (target !== 'auth') el.focus({ preventScroll: true }); }
    if (target === 'claim') handleClaimCheck();
  }

  /* ==================== SPL TOKEN CREATE (dipakai Create & Clone) ==================== */
  /**
   * @param {object} [meta] { name, symbol, uri } — metadata Metaplex on-chain (dibuat dalam transaksi yang sama)
   */
  async function createSplToken(connection, payer, decimals, amount, meta) {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;
    const rent = await connection.getMinimumBalanceForRentExemption(SplToken.MINT_SIZE);
    const ata = await SplToken.getAssociatedTokenAddress(mint, payer);

    const tx = new Transaction();
    tx.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint,
        lamports: rent,
        space: SplToken.MINT_SIZE,
        programId: SplToken.TOKEN_PROGRAM_ID,
      }),
      SplToken.createInitializeMintInstruction(mint, decimals, payer, null),
      SplToken.createAssociatedTokenAccountInstruction(payer, ata, payer, mint),
      SplToken.createMintToInstruction(mint, ata, payer, amount)
    );

    // Metadata Metaplex (nama, symbol, URI) — wallet/explorer menampilkan nama token
    const hasMeta = meta && ((meta.name && meta.name.trim()) || (meta.symbol && meta.symbol.trim()) || (meta.uri && meta.uri.trim()));
    if (hasMeta) {
      tx.add(
        Metaplex.createMetadataAccountV3Instruction({
          mint,
          mintAuthority: payer,
          payer,
          updateAuthority: payer,
          name: (meta.name || '').trim(),
          symbol: (meta.symbol || '').trim(),
          uri: (meta.uri || '').trim(),
          isMutable: true,
        })
      );
    }

    // Akun mint baru wajib ikut menandatangani createAccount; wallet menandatangani sebagai fee payer
    tx.partialSign(mintKeypair);

    const signature = await Wallet.sendTransaction(tx, connection);
    await confirmTx(connection, signature, blockhash, lastValidBlockHeight);
    return { mint: mint.toString(), signature, metadata: !!hasMeta };
  }

  /* ==================== CREATE TOKEN ==================== */
  async function handleCreate(e) {
    e.preventDefault();
    S.createLoading = true;
    S.createError = '';
    S.createResult = null;
    renderCreate();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey) throw new Error('Wallet not connected');
      const connection = getConnection();
      const f = formValues('form-create');
      const decimals = parseInt(f.decimals, 10);
      if (isNaN(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimals');
      const supply = parseFloat(f.initialSupply);
      if (isNaN(supply) || supply <= 0) throw new Error('Invalid supply');
      const amount = Math.floor(supply * Math.pow(10, decimals));

      Metaplex.validateData({ name: f.name, symbol: f.symbol, uri: f.metadataUri });
      const { mint, signature } = await createSplToken(connection, publicKey, decimals, amount, {
        name: f.name,
        symbol: f.symbol,
        uri: f.metadataUri,
      });

      const record = {
        mint,
        name: f.name,
        symbol: f.symbol,
        decimals,
        supply,
        signature,
        createdAt: new Date().toISOString(),
      };
      saveTokens([record, ...S.tokens]);
      S.createResult = { mint, signature, decimals };
    } catch (err) {
      S.createError = (err && err.message) || 'Create failed';
      console.error(err);
    } finally {
      S.createLoading = false;
      renderCreate();
    }
  }

  function renderCreate() {
    setHTML('create-result', S.createResult ? tokenResultBox('TOKEN BERHASIL DIBUAT', 'MINT', S.createResult) : '');
    setHTML('create-error', errorBox(S.createError));
    renderButtons();
  }

  /* ==================== CLONE TOKEN ==================== */
  async function fetchCloneSource() {
    const cloneInput = val('clone-input');
    if (!cloneInput.trim()) return;
    S.cloneFetching = true;
    S.cloneError = '';
    renderClone();
    try {
      const connection = getConnection();
      const mintPubkey = new PublicKey(cloneInput);
      // Dukung SPL Token & Token-2022 (program pemilik akun mint)
      const acc = await connection.getAccountInfo(mintPubkey);
      if (!acc) throw new Error('Mint not found');
      const programId = acc.owner.equals(SplToken.TOKEN_2022_PROGRAM_ID) ? SplToken.TOKEN_2022_PROGRAM_ID : SplToken.TOKEN_PROGRAM_ID;
      const mintInfo = await SplToken.getMint(connection, mintPubkey, 'confirmed', programId);
      const supply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
      // Metadata Metaplex sumber (nama, symbol, URI) — jika ada
      let meta = null;
      try {
        meta = await Metaplex.getMetadata(connection, mintPubkey);
      } catch (_) {
        meta = null;
      }
      const name = meta && meta.name ? meta.name : 'Cloned Token';
      const symbol = meta && meta.symbol ? meta.symbol : 'CLONE';
      S.cloneData = {
        mint: cloneInput,
        name,
        symbol,
        uri: meta ? meta.uri : '',
        hasMetadata: !!meta,
        decimals: mintInfo.decimals,
        supply,
      };
      setCloneForm({
        name,
        symbol,
        decimals: String(mintInfo.decimals),
        initialSupply: String(supply),
      });
    } catch (err) {
      S.cloneError = (err && err.message) || 'Failed to fetch source token';
      console.error(err);
    } finally {
      S.cloneFetching = false;
      renderClone();
    }
  }

  function setCloneForm(v) {
    const form = document.getElementById('form-clone');
    form.elements.name.value = v.name;
    form.elements.symbol.value = v.symbol;
    form.elements.decimals.value = v.decimals;
    form.elements.initialSupply.value = v.initialSupply;
  }

  function useCloneSource() {
    if (!S.cloneData) return;
    setCloneForm({
      name: S.cloneData.name,
      symbol: S.cloneData.symbol,
      decimals: String(S.cloneData.decimals),
      initialSupply: String(S.cloneData.supply),
    });
  }

  async function handleClone(e) {
    e.preventDefault();
    S.cloneLoading = true;
    S.cloneError = '';
    S.cloneResult = null;
    renderClone();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey) throw new Error('Wallet not connected');
      const connection = getConnection();
      const f = formValues('form-clone');
      const decimals = parseInt(f.decimals, 10);
      if (isNaN(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimals');
      const supply = parseFloat(f.initialSupply);
      if (isNaN(supply) || supply <= 0) throw new Error('Invalid supply');
      const amount = Math.floor(supply * Math.pow(10, decimals));

      const sourceUri = S.cloneData && S.cloneData.uri ? S.cloneData.uri : '';
      Metaplex.validateData({ name: f.name, symbol: f.symbol, uri: sourceUri });
      const { mint, signature } = await createSplToken(connection, publicKey, decimals, amount, {
        name: f.name,
        symbol: f.symbol,
        uri: sourceUri, // URI metadata ikut di-clone dari sumber (jika ada)
      });

      const record = {
        mint,
        name: f.name,
        symbol: f.symbol,
        decimals,
        supply,
        signature,
        createdAt: new Date().toISOString(),
      };
      saveTokens([record, ...S.tokens]);
      S.cloneResult = { mint, signature, decimals };
    } catch (err) {
      S.cloneError = (err && err.message) || 'Clone failed';
      console.error(err);
    } finally {
      S.cloneLoading = false;
      renderClone();
    }
  }

  function renderClone() {
    // cloneError tampil di dua tempat (setelah input sumber & setelah form), sama seperti versi asli
    setHTML('clone-error-top', errorBox(S.cloneError, 'mt-0'));
    setHTML('clone-error', errorBox(S.cloneError));
    setHTML(
      'clone-data',
      S.cloneData
        ? `<div class="source-box">
            <h3 class="source-title">DATA SUMBER DITEMUKAN</h3>
            <div class="kv-grid">
              <div><p class="k">MINT SOURCE</p><p class="v purple truncate">${esc(S.cloneData.mint)}</p></div>
              ${S.cloneData.hasMetadata ? `<div><p class="k">NAMA (METADATA)</p><p class="v purple truncate">${esc(S.cloneData.name)}</p></div>
              <div><p class="k">SYMBOL</p><p class="v purple">${esc(S.cloneData.symbol)}</p></div>` : ''}
              <div><p class="k">DECIMALS</p><p class="v purple">${esc(S.cloneData.decimals)}</p></div>
              <div><p class="k">SUPPLY</p><p class="v purple">${esc(S.cloneData.supply)}</p></div>
              <div><p class="k">CLUSTER</p><p class="v purple">${cluster()}</p></div>
            </div>
            <button type="button" class="link-btn cyan mono" id="btn-use-source">[GUNAKAN PARAMETER INI]</button>
          </div>`
        : ''
    );
    setHTML('clone-result', S.cloneResult ? tokenResultBox('CLONE BERHASIL DIBUAT', 'MINT BARU', S.cloneResult) : '');
    renderButtons();
  }

  /* ==================== SWAP (JUPITER) ==================== */
  async function fetchQuote() {
    S.swapError = '';
    S.swapQuoting = true;
    renderSwap();
    try {
      const f = formValues('form-swap');
      const inputMint = f.inputMint === NATIVE_SOL ? WRAPPED_SOL : f.inputMint;
      const amountLamports = Math.floor(parseFloat(f.amount) * Math.pow(10, 9));
      const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${f.outputMint}&amount=${amountLamports}&slippageBps=${f.slippage}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Quote failed');
      S.swapQuote = await res.json();
    } catch (err) {
      S.swapError = (err && err.message) || 'Quote error';
      console.error(err);
    } finally {
      S.swapQuoting = false;
      renderSwap();
    }
  }

  async function executeSwap() {
    if (!S.swapQuote) return;
    S.swapLoading = true;
    renderSwap();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey) throw new Error('Wallet not connected');
      const connection = getConnection();

      const swapRes = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: S.swapQuote,
          userPublicKey: publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
      if (!swapRes.ok) throw new Error('Swap tx failed');
      const swapData = await swapRes.json();

      const txBuf = base64ToBytes(swapData.swapTransaction);
      const tx = VersionedTransaction.deserialize(txBuf);
      const signed = await Wallet.signTransaction(tx);
      if (!signed) throw new Error('Sign failed');
      const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
      await confirmTx(connection, signature, tx.message.recentBlockhash, swapData.lastValidBlockHeight);

      S.swapResult = { signature };
    } catch (err) {
      S.swapError = (err && err.message) || 'Swap failed';
      console.error(err);
    } finally {
      S.swapLoading = false;
      renderSwap();
    }
  }

  function renderSwap() {
    const q = S.swapQuote;
    setHTML(
      'swap-quote',
      q
        ? `<div class="quote-box">
            <h3 class="quote-title">QUOTE DITERIMA</h3>
            <div class="kv-grid">
              <div><p class="k">INPUT AMOUNT</p><p class="v">${q.inAmount ? (parseInt(q.inAmount) / 1e9).toFixed(6) : '-'} SOL</p></div>
              <div><p class="k">OUTPUT AMOUNT</p><p class="v">${q.outAmount ? (parseInt(q.outAmount) / 1e6).toFixed(4) : '-'} TOKEN</p></div>
              <div><p class="k">PRICE IMPACT</p><p class="v">${q.priceImpactPct ? parseFloat(q.priceImpactPct).toFixed(4) + '%' : '-'}</p></div>
              <div><p class="k">ROUTE</p><p class="v">${q.routePlan ? q.routePlan.length + ' hops' : '-'}</p></div>
            </div>
          </div>`
        : ''
    );
    setHTML(
      'swap-result',
      S.swapResult
        ? `<div class="result-box mt-4">
            <h3 class="result-title">SWAP BERHASIL</h3>
            <p class="result-text truncate">${esc(S.swapResult.signature)}</p>
            <a href="${txLink(S.swapResult.signature)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI</a>
          </div>`
        : ''
    );
    setHTML('swap-error', errorBox(S.swapError));
    renderButtons();
  }

  /* ==================== LIQUIDITY CPMM (RAYDIUM) ==================== */
  async function handleLiquidityAction(action) {
    S.liqLoading = true;
    S.liqError = '';
    S.liqResult = null;
    renderLiq();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey || !S.raydiumCpmm) throw new Error('Wallet/Raydium not ready');
      const liqForm = {
        mintA: val('liq-mintA'), mintB: val('liq-mintB'), priceA: val('liq-priceA'),
        amountA: val('liq-amountA'), amountB: val('liq-amountB'), poolId: val('liq-poolId'),
        liquidity: val('liq-liquidity'), minAmountA: val('liq-minA'), minAmountB: val('liq-minB'),
      };

      if (action === 'create') {
        if (!liqForm.mintA || !liqForm.mintB || !liqForm.priceA) throw new Error('Mint A, Mint B and Price required');
        const res = await S.raydiumCpmm.createPool({
          tokenA: liqForm.mintA,
          tokenB: liqForm.mintB,
          priceA: parseFloat(liqForm.priceA),
          amountA: liqForm.amountA, // likuiditas awal (yang kosong dihitung dari PRICE A)
          amountB: liqForm.amountB,
        });
        S.liqResult = {
          message: `Raydium CPMM pool created on ${cluster()}. Pool: ${res.poolId}`,
          detail: `Likuiditas awal: ${res.amountA} A + ${res.amountB} B (harga A = ${res.price} B, trade fee ${res.tradeFeeRate / 10000}%). LP mint: ${res.lpMint}`,
          signature: res.signature,
        };
      } else if (action === 'deposit') {
        if (!liqForm.poolId || !liqForm.amountA || !liqForm.amountB) throw new Error('Pool ID and amounts required');
        const res = await S.raydiumCpmm.deposit({
          poolId: liqForm.poolId,
          mintA: liqForm.mintA, // orientasi A/B mengikuti MINT A di form (jika diisi)
          amountA: parseFloat(liqForm.amountA),
          amountB: parseFloat(liqForm.amountB),
        });
        S.liqResult = {
          message: `Liquidity added on ${cluster()}.`,
          detail: `Disetor ≈ ${res.amountA} A + ${res.amountB} B ke pool ${res.poolId}`,
          signature: res.signature,
        };
      } else if (action === 'withdraw') {
        if (!liqForm.poolId || !liqForm.liquidity) throw new Error('Pool ID and liquidity required');
        const res = await S.raydiumCpmm.withdraw({
          poolId: liqForm.poolId,
          mintA: liqForm.mintA,
          liquidity: parseFloat(liqForm.liquidity),
          minAmountA: parseFloat(liqForm.minAmountA || '0'),
          minAmountB: parseFloat(liqForm.minAmountB || '0'),
        });
        S.liqResult = {
          message: `Liquidity removed on ${cluster()}.`,
          detail: `Estimasi diterima ≈ ${res.amountA} A + ${res.amountB} B (LP ${liqForm.liquidity})`,
          signature: res.signature,
        };
      }
    } catch (err) {
      S.liqError = (err && err.message) || 'Liquidity action failed';
      console.error(err);
    } finally {
      S.liqLoading = false;
      renderLiq();
    }
  }

  function renderLiq() {
    const r = S.liqResult;
    setHTML(
      'liq-result',
      r
        ? `<div class="result-box mt-4">
            <h3 class="result-title">LIQUIDITY ACTION</h3>
            <p class="result-text">${esc(r.message)}</p>
            ${r.detail ? `<p class="result-sub">${esc(r.detail)}</p>` : ''}
            ${r.signature ? `<div style="margin-top:8px"><a href="${txLink(r.signature)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI</a></div>` : ''}
          </div>`
        : ''
    );
    setHTML('liq-error', errorBox(S.liqError));
    renderButtons();
  }

  /* ==================== LIQUIDITY CLMM (RAYDIUM) ==================== */
  async function handleClmmAction(action) {
    S.clmmLoading = true;
    S.clmmError = '';
    S.clmmResult = null;
    renderClmm();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey || !S.raydiumClmm) throw new Error('Wallet/Raydium CLMM not ready');
      const clmmForm = {
        mintA: val('clmm-mintA'), mintB: val('clmm-mintB'),
        decimalsA: val('clmm-decimalsA'), decimalsB: val('clmm-decimalsB'),
        initialPrice: val('clmm-initialPrice'), priceLower: val('clmm-priceLower'), priceUpper: val('clmm-priceUpper'),
        feeRate: val('clmm-feeRate'), amountA: val('clmm-amountA'), amountB: val('clmm-amountB'), poolId: val('clmm-poolId'),
      };

      if (action === 'createPool') {
        if (!clmmForm.mintA || !clmmForm.mintB || !clmmForm.initialPrice || !clmmForm.priceLower || !clmmForm.priceUpper) {
          throw new Error('Mint A, Mint B, initial price, and price range required');
        }
        const res = await S.raydiumClmm.createPool({
          mintA: clmmForm.mintA,
          mintB: clmmForm.mintB,
          decimalsA: parseInt(clmmForm.decimalsA, 10) || 9,
          decimalsB: parseInt(clmmForm.decimalsB, 10) || 9,
          initialPrice: parseFloat(clmmForm.initialPrice),
          priceLower: parseFloat(clmmForm.priceLower),
          priceUpper: parseFloat(clmmForm.priceUpper),
          feeRate: parseInt(clmmForm.feeRate, 10) || 2500,
          inputAmountA: clmmForm.amountA,
          inputAmountB: clmmForm.amountB,
        });
        S.clmmResult = {
          message: `Raydium CLMM pool created on ${cluster()}. Range: ${clmmForm.priceLower} – ${clmmForm.priceUpper}`,
          detail: res.positionSignature
            ? `Posisi likuiditas dibuka: ${res.amountA} A + ${res.amountB} B (NFT posisi ${res.nftMint}). Trade fee ${res.tradeFeeRate / 10000}%.`
            : `Pool dibuat tanpa posisi (isi AMOUNT A/B lalu ADD LIQUIDITY CLMM). Trade fee ${res.tradeFeeRate / 10000}%.`,
          signature: res.signature,
          positionSignature: res.positionSignature,
          poolId: res.poolId,
          tickLower: res.tickLower,
          tickUpper: res.tickUpper,
        };
      } else if (action === 'deposit') {
        if (!clmmForm.poolId) throw new Error('Pool ID required');
        // Rentang harga form -> tick (dibulatkan ke tickSpacing pool); posisi baru dibuka pada rentang ini
        const res = await S.raydiumClmm.deposit({
          poolId: clmmForm.poolId,
          mintA: clmmForm.mintA, // orientasi harga/jumlah mengikuti MINT A di form (jika diisi)
          priceLower: clmmForm.priceLower,
          priceUpper: clmmForm.priceUpper,
          amountA: clmmForm.amountA,
          amountB: clmmForm.amountB,
        });
        S.clmmResult = {
          message: `CLMM liquidity added on ${cluster()}.`,
          detail: `Posisi: ${res.amountA} A + ${res.amountB} B pada rentang ${clmmForm.priceLower} – ${clmmForm.priceUpper} (NFT posisi ${res.nftMint})`,
          signature: res.signature,
          poolId: res.poolId,
          tickLower: res.tickLower,
          tickUpper: res.tickUpper,
        };
      }
    } catch (err) {
      S.clmmError = (err && err.message) || 'CLMM action failed';
      console.error(err);
    } finally {
      S.clmmLoading = false;
      renderClmm();
    }
  }

  function renderClmm() {
    const r = S.clmmResult;
    const latest = document.getElementById('clmm-latest-pool');
    if (r && r.poolId) {
      latest.textContent = `Pool ID terbaru: ${r.poolId}`;
      latest.hidden = false;
    } else {
      latest.hidden = true;
    }
    setHTML(
      'clmm-result',
      r
        ? `<div class="result-box mt-4">
            <h3 class="result-title">CLMM ACTION BERHASIL</h3>
            <p class="result-text">${esc(r.message)}</p>
            ${r.detail ? `<p class="result-sub">${esc(r.detail)}</p>` : ''}
            ${r.poolId ? `<p class="result-sub truncate">Pool ID: ${esc(r.poolId)}</p>` : ''}
            ${r.tickLower !== undefined && r.tickUpper !== undefined ? `<p class="result-sub">Tick Range: ${esc(r.tickLower)} – ${esc(r.tickUpper)}</p>` : ''}
            ${r.signature ? `<div style="margin-top:8px"><a href="${txLink(r.signature)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI</a></div>` : ''}
            ${r.positionSignature ? `<div style="margin-top:4px"><a href="${txLink(r.positionSignature)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI POSISI</a></div>` : ''}
          </div>`
        : ''
    );
    setHTML('clmm-error', errorBox(S.clmmError));
    renderButtons();
  }

  /* ==================== RAYDIUM SDK (lazy load + init saat wallet connect) ==================== */
  let raydiumScriptPromise = null;
  function loadRaydiumBundle() {
    if (window.RaydiumSDK) return Promise.resolve();
    if (!raydiumScriptPromise) {
      raydiumScriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/raydium-sdk.js';
        s.onload = () => resolve();
        s.onerror = () => { raydiumScriptPromise = null; reject(new Error('Gagal memuat vendor/raydium-sdk.js')); };
        document.head.appendChild(s);
      });
    }
    return raydiumScriptPromise;
  }

  async function syncRaydium() {
    const publicKey = Wallet.publicKey;
    const onLiquidityTab = S.tab === 'liquidity' || S.tab === 'clmm';
    if (!publicKey || !onLiquidityTab || S.raydiumLoading) { renderSdkStatus(); return; }
    const key = S.network + ':' + publicKey.toString();
    if (S.raydiumKey === key) { renderSdkStatus(); return; }

    S.raydiumLoading = true;
    S.raydiumError = '';
    S.raydiumKey = null;
    S.raydiumCpmm = null;
    S.raydiumClmm = null;
    renderSdkStatus();
    try {
      await loadRaydiumBundle();
      const connection = getConnection();
      const sendTransaction = (tx) => Wallet.sendTransaction(tx, connection);
      const signAllTransactions = (txs) => Promise.all(txs.map((t) => Wallet.signTransaction(t)));

      const cpmmInstance = new window.RaydiumCpmm(cluster(), RPC_URLS[S.network]);
      await cpmmInstance.init(publicKey, sendTransaction, signAllTransactions);

      const clmmInstance = new window.RaydiumClmm(cluster(), RPC_URLS[S.network]);
      await clmmInstance.init(publicKey, sendTransaction, signAllTransactions);

      S.raydiumCpmm = cpmmInstance;
      S.raydiumClmm = clmmInstance;
      S.raydiumKey = key;
    } catch (err) {
      S.raydiumError = (err && err.message) || 'Raydium init failed';
      console.error(err);
    } finally {
      S.raydiumLoading = false;
      renderSdkStatus();
      // Jika wallet/jaringan berubah selama proses init, ulangi
      const pk = Wallet.publicKey;
      if (pk && (S.tab === 'liquidity' || S.tab === 'clmm') && S.raydiumKey !== S.network + ':' + pk.toString() && !S.raydiumError) {
        syncRaydium();
      }
    }
  }

  function renderSdkStatus() {
    let text = '';
    let cls = 'hint mono sdk-status';
    if (!Wallet.publicKey) text = 'Raydium SDK: menunggu wallet connect.';
    else if (S.raydiumLoading) text = 'Raydium SDK: memuat & inisialisasi…';
    else if (S.raydiumError) { text = 'Raydium SDK error: ' + S.raydiumError; cls += ' text-red'; }
    else if (S.raydiumCpmm && S.raydiumClmm) { text = `Raydium SDK siap (${cluster()}).`; cls += ' text-green'; }
    for (const id of ['liq-sdk-status', 'clmm-sdk-status']) {
      const el = document.getElementById(id);
      if (el) { el.textContent = text; el.className = cls; }
    }
  }

  /* ==================== TOKEN-2022 TRANSFER FEE ==================== */
  async function handleCreateToken2022(e) {
    e.preventDefault();
    S.t22Loading = true;
    S.t22Error = '';
    S.t22Result = null;
    renderT22();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey) throw new Error('Wallet not connected');
      if (!S.token2022Manager) throw new Error('Token-2022 manager not ready');

      const f = formValues('form-t22');
      const decimals = parseInt(f.decimals, 10);
      if (isNaN(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimals');
      const supply = parseFloat(f.initialSupply);
      if (isNaN(supply) || supply <= 0) throw new Error('Invalid supply');
      const basisPoints = parseInt(f.transferFeeBasisPoints, 10);
      if (isNaN(basisPoints) || basisPoints < 0 || basisPoints > 10000) throw new Error('Basis points must be 0-10000');
      const feeMax = parseInt(f.transferFeeMax, 10);
      if (isNaN(feeMax) || feeMax < 0) throw new Error('Invalid max fee');
      const feeRecipient = f.feeRecipient || publicKey.toString();

      const res = await S.token2022Manager.createTokenWithFee(
        {
          name: f.name,
          symbol: f.symbol,
          decimals,
          supply,
          transferFeeBasisPoints: basisPoints,
          transferFeeMax: feeMax,
          feeRecipient,
        },
        publicKey,
        (tx) => Wallet.sendTransaction(tx, getConnection())
      );

      S.t22Result = { mint: res.mint, signature: res.signature, decimals: f.decimals, token2022: true };
      // Siapkan kartu klaim fee untuk token yang baru dibuat
      const claimInput = document.getElementById('claim-mint');
      if (claimInput && !claimInput.value) { claimInput.value = res.mint; S.claimScan = null; S.claimResult = null; S.claimError = ''; }
    } catch (err) {
      S.t22Error = (err && err.message) || 'Token-2022 create failed';
      console.error(err);
    } finally {
      S.t22Loading = false;
      renderT22();
    }
  }

  function renderT22() {
    let html = '';
    if (S.t22Result) {
      const f = formValues('form-t22');
      const pk = Wallet.publicKey;
      const bps = parseInt(f.transferFeeBasisPoints);
      const feeBox = `
        <div class="fee-box">
          <p>Fee konfigurasi:</p>
          <p>• Basis Points: ${esc(f.transferFeeBasisPoints)} bps (${isNaN(bps) ? 'NaN' : (bps / 100).toFixed(2)}%)</p>
          <p>• Max Fee: ${Number(f.transferFeeMax) > 0 ? esc(f.transferFeeMax) + ' unit terkecil (' + esc(window.Token2022Manager.formatUnits(f.transferFeeMax, parseInt(f.decimals, 10) || 0)) + ' token)' : 'tanpa cap (u64 max)'}</p>
          <p>• Recipient: ${esc(f.feeRecipient || (pk ? pk.toString().slice(0, 4) + '...' : 'undefined...'))}</p>
        </div>`;
      html = tokenResultBox('TOKEN-2022 BERHASIL DIBUAT', 'MINT', S.t22Result, feeBox);
    }
    setHTML('t22-result', html);
    setHTML('t22-error', errorBox(S.t22Error));
    renderClaim();
  }

  /* ==================== KLAIM FEE TERTAHAN (Token-2022) ==================== */
  function getT22Manager() {
    if (!S.token2022Manager || S.token2022Manager._rpc !== RPC_URLS[S.network]) {
      S.token2022Manager = new window.Token2022Manager(RPC_URLS[S.network]);
      S.token2022Manager._rpc = RPC_URLS[S.network];
    }
    return S.token2022Manager;
  }

  async function handleClaimCheck() {
    const mint = val('claim-mint').trim();
    if (!mint) return;
    S.claimChecking = true;
    S.claimError = '';
    S.claimResult = null;
    S.claimScan = null;
    renderClaim();
    try {
      new PublicKey(mint); // validasi alamat
      S.claimScan = await getT22Manager().scanWithheldFees(mint);
    } catch (err) {
      S.claimError = (err && err.message) || 'Gagal memeriksa fee';
      console.error(err);
    } finally {
      S.claimChecking = false;
      renderClaim();
    }
  }

  async function handleClaim() {
    const publicKey = Wallet.publicKey;
    const mint = val('claim-mint').trim();
    if (!publicKey || !mint) return;
    S.claimLoading = true;
    S.claimError = '';
    S.claimResult = null;
    renderClaim();
    try {
      const manager = getT22Manager();
      const scan = await manager.scanWithheldFees(mint); // selalu pindai ulang agar data terbaru
      S.claimScan = scan;
      const connection = getConnection();
      const res = await manager.claimWithheldFees({
        mint,
        payer: publicKey,
        scan,
        sendTransaction: (tx) => Wallet.sendTransaction(tx, connection),
      });
      S.claimResult = res;
      S.claimScan = await manager.scanWithheldFees(mint).catch(() => scan);
    } catch (err) {
      S.claimError = (err && err.message) || 'Klaim gagal';
      console.error(err);
    } finally {
      S.claimLoading = false;
      renderClaim();
    }
  }

  function renderClaim() {
    const fmt = (raw, dec) => window.Token2022Manager.formatUnits(raw, dec);
    const sc = S.claimScan;
    const pk = Wallet.publicKey;
    let info = '';
    if (S.claimChecking) {
      info = '<div class="claim-info">Memeriksa konfigurasi fee & akun token…</div>';
    } else if (sc) {
      const cfg = sc.feeConfig;
      const fee = cfg.newerTransferFee;
      const auth = cfg.withdrawWithheldAuthority ? cfg.withdrawWithheldAuthority.toBase58() : null;
      const isAuth = !!(pk && auth && auth === pk.toString());
      const u64max = '18446744073709551615';
      const rows = sc.accounts.slice(0, 10).map((a) => `<tr><td class="truncate">${esc(a.address.toBase58())}</td><td class="r">${fmt(a.withheld, sc.decimals)}</td></tr>`).join('');
      info = `
        <div class="claim-info">
          <p>Fee: <span class="ok">${fee.transferFeeBasisPoints} bps (${(fee.transferFeeBasisPoints / 100).toFixed(2)}%)</span>
             · Max fee per transfer: <span class="ok">${fee.maximumFee.toString() === u64max ? 'tanpa cap' : fmt(fee.maximumFee, sc.decimals)}</span>
             · Decimals: ${sc.decimals}</p>
          <p>Withdraw authority (FEE RECIPIENT): <span class="${isAuth ? 'ok' : 'bad'}">${esc(auth || '— (tidak ada)')}</span>
             ${pk ? `— ${isAuth ? '<span class="ok">wallet ini ✔</span>' : '<span class="bad">bukan wallet ini ✘</span>'}` : ''}</p>
          <p>Akun token dipindai: ${sc.scanned} (${sc.method})${sc.method === 'getTokenLargestAccounts' ? ' — RPC ini menolak getProgramAccounts, hanya 20 akun terbesar yang diperiksa' : ''}</p>
          <p>Tertahan di ${sc.accounts.length} akun: <span class="ok">${fmt(sc.accountsTotal, sc.decimals)}</span>
             · di akun mint: <span class="ok">${fmt(sc.mintWithheld, sc.decimals)}</span></p>
          <p class="big">TOTAL BISA DIKLAIM: ${fmt(sc.total, sc.decimals)}</p>
          ${rows ? `<table>${rows}${sc.accounts.length > 10 ? `<tr><td colspan="2">… ${sc.accounts.length - 10} akun lainnya</td></tr>` : ''}</table>` : ''}
        </div>`;
    }
    setHTML('claim-info', info);
    const r = S.claimResult;
    setHTML(
      'claim-result',
      r
        ? `<div class="result-box mt-4">
            <h3 class="result-title">FEE BERHASIL DIKLAIM</h3>
            <p class="result-text">${fmt(r.claimed, r.decimals)} token ditarik dari ${r.accountsCount} akun ke akun token wallet Anda.</p>
            <p class="result-sub truncate">Tujuan (ATA Token-2022): ${esc(r.destination)}</p>
            ${r.signatures.map((sig, i) => `<div style="margin-top:${i ? 2 : 8}px"><a href="${txLink(sig)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI${r.signatures.length > 1 ? ' ' + (i + 1) : ''}</a></div>`).join('')}
          </div>`
        : ''
    );
    setHTML('claim-error', errorBox(S.claimError));
    renderButtons();
  }

  /* ==================== REVOKE AUTHORITY ==================== */
  const AUTH_DESC = {
    mint: 'Mint authority: Can create new tokens. Revoking makes supply fixed.',
    freeze: 'Freeze authority: Can freeze/unfreeze token accounts. Revoking prevents freezing.',
    update: 'Update authority: Can change token metadata (Metaplex). Revoking makes metadata immutable.',
  };

  function setAuthorityType(t) {
    S.authorityType = t;
    renderAuth();
  }

  async function handleRevoke(e) {
    e.preventDefault();
    S.authLoading = true;
    S.authError = '';
    S.authResult = null;
    renderAuth();
    try {
      const publicKey = Wallet.publicKey;
      if (!publicKey) throw new Error('Wallet not connected');
      const mintAddress = val('auth-mint');
      if (!mintAddress.trim()) throw new Error('Mint address required');

      const connection = getConnection();
      const mintPubkey = new PublicKey(mintAddress);

      // Gunakan program pemilik mint (SPL Token atau Token-2022) agar revoke valid untuk keduanya
      const mintInfo = await connection.getAccountInfo(mintPubkey);
      if (!mintInfo) throw new Error('Mint not found');
      const programId = mintInfo.owner.equals(SplToken.TOKEN_2022_PROGRAM_ID) ? SplToken.TOKEN_2022_PROGRAM_ID : SplToken.TOKEN_PROGRAM_ID;

      const tx = new Transaction();
      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      if (S.authorityType === 'mint' || S.authorityType === 'freeze') {
        // Periksa authority saat ini agar pesan error jelas (bukan sekadar "custom program error")
        const parsed = SplToken.unpackMint(mintPubkey, mintInfo);
        const current = S.authorityType === 'mint' ? parsed.mintAuthority : parsed.freezeAuthority;
        const label = S.authorityType === 'mint' ? 'Mint authority' : 'Freeze authority';
        if (!current) throw new Error(`${label} token ini sudah tidak ada (sudah dicabut atau tidak pernah diset)`);
        if (!current.equals(publicKey)) throw new Error(`${label} bukan wallet ini (authority: ${current.toString()})`);
        const authType = S.authorityType === 'mint' ? SplToken.AuthorityType.MintTokens : SplToken.AuthorityType.FreezeAccount;
        tx.add(SplToken.createSetAuthorityInstruction(mintPubkey, publicKey, authType, null, [], programId));
      } else if (S.authorityType === 'update') {
        // Metadata Metaplex: cabut hak ubah dengan menjadikan metadata permanen (isMutable = false)
        const meta = await Metaplex.getMetadata(connection, mintPubkey);
        if (!meta) throw new Error('Token ini tidak memiliki metadata Metaplex (tidak ada update authority yang bisa dicabut)');
        if (meta.updateAuthority !== publicKey.toString()) {
          throw new Error(`Update authority metadata bukan wallet ini (authority: ${meta.updateAuthority})`);
        }
        if (meta.isMutable === false) throw new Error('Metadata token ini sudah immutable (update authority sudah dicabut)');
        tx.add(Metaplex.createRevokeUpdateAuthorityInstruction(mintPubkey, publicKey));
      }

      const signature = await Wallet.sendTransaction(tx, connection);
      await confirmTx(connection, signature, blockhash, lastValidBlockHeight);

      S.authResult = { signature, type: S.authorityType };
    } catch (err) {
      S.authError = (err && err.message) || 'Revoke failed';
      console.error(err);
    } finally {
      S.authLoading = false;
      renderAuth();
    }
  }

  function renderAuth() {
    const t = S.authorityType;
    $$('.auth-type').forEach((b) => b.classList.toggle('active', b.dataset.type === t));
    const sel = document.getElementById('auth-type');
    if (sel.value !== t) sel.value = t;
    document.getElementById('auth-type-desc').textContent = AUTH_DESC[t];
    document.getElementById('auth-update-warn').hidden = t !== 'update';
    setHTML(
      'auth-result',
      S.authResult
        ? `<div class="result-box">
            <h3 class="result-title">AUTHORITY REVOKED</h3>
            <p class="result-text truncate">${esc(S.authResult.signature)}</p>
            <a href="${txLink(S.authResult.signature)}" target="_blank" rel="noopener noreferrer" class="result-link">LIHAT TRANSAKSI</a>
          </div>`
        : ''
    );
    setHTML('auth-error', errorBox(S.authError));
    renderButtons();
  }

  /* ==================== TOKEN LIST ==================== */
  function renderList() {
    if (S.tokens.length === 0) {
      setHTML('token-list', '<div class="empty">Belum ada token. Buat atau clone di tab CREATE / CLONE.</div>');
      return;
    }
    const rows = S.tokens
      .map(
        (token) => `
        <tr>
          <td>${esc(token.name)}</td>
          <td class="sym">${esc(token.symbol)}</td>
          <td class="sup">${esc(token.supply)}</td>
          <td class="mint">${esc(token.mint)}</td>
          <td>
            <div class="chips" style="gap:4px">
              <button type="button" class="chip chip-sm copy" data-copy="${esc(token.mint)}">[COPY]</button>
              ${dexChips(token.mint)}
              <button type="button" class="chip chip-sm use c-green" data-use-pool="cpmm" data-mint="${esc(token.mint)}" data-decimals="${esc(token.decimals)}">→ POOL CPMM</button>
              <button type="button" class="chip chip-sm use c-orange" data-use-pool="clmm" data-mint="${esc(token.mint)}" data-decimals="${esc(token.decimals)}">→ POOL CLMM</button>
              <button type="button" class="chip chip-sm use c-purple" data-use-auth="${esc(token.mint)}">→ REVOKE</button>
            </div>
          </td>
        </tr>`
      )
      .join('');
    setHTML(
      'token-list',
      `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>NAMA</th><th>SYMBOL</th><th>SUPPLY</th><th>MINT</th><th>AKSI</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    );
  }

  /* ==================== CONNECT BUTTON ==================== */
  function walletMenuHtml() {
    const items = Wallet.detect()
      .map((w) =>
        w.installed
          ? `<button type="button" class="wallet-item" data-wallet="${w.name}">${w.name} <small>Detected</small></button>`
          : `<a class="wallet-item not-installed" href="${w.url}" target="_blank" rel="noopener noreferrer">${w.name} <small>Not installed — install</small></a>`
      )
      .join('');
    return `<div class="wallet-menu mono"><div class="wallet-menu-title">PILIH WALLET</div>${items}</div>`;
  }

  function renderConnect() {
    const wrap = document.getElementById('connect-wrap');
    const st = Wallet.getState();
    if (st.connecting) {
      wrap.innerHTML = '<button type="button" class="btn-connecting pulse" disabled>Connecting...</button>';
      return;
    }
    if (!st.connected) {
      wrap.innerHTML =
        `<button type="button" class="btn-connect ${S.connectError ? 'has-error' : ''}" id="btn-connect">Connect Wallet</button>` +
        (S.connectError ? `<div class="connect-error mono">${esc(S.connectError)}</div>` : '') +
        (S.walletMenuOpen ? walletMenuHtml() : '');
      return;
    }
    wrap.innerHTML = `
      <div class="connect-row">
        <span class="wallet-addr mono truncate">${shortAddr(st.publicKey)}</span>
        <button type="button" class="btn-disconnect" id="btn-disconnect">Disconnect</button>
      </div>`;
  }

  async function handleConnect() {
    S.connectError = null;
    const installed = Wallet.detect().filter((w) => w.installed);
    if (installed.length === 0) {
      S.connectError = 'No wallet adapter available';
      S.walletMenuOpen = true; // tampilkan tautan install Phantom / Solflare
      renderConnect();
      return;
    }
    if (installed.length === 1) {
      await connectWith(installed[0].name);
      return;
    }
    S.walletMenuOpen = !S.walletMenuOpen;
    renderConnect();
  }

  async function connectWith(name) {
    S.walletMenuOpen = false;
    S.connectError = null;
    renderConnect();
    try {
      await Wallet.connect(name);
    } catch (err) {
      S.connectError = (err && err.message) || 'Failed to connect wallet';
      console.error('Wallet connect error:', err);
      renderConnect();
    }
  }

  /* ==================== NETWORK / WALLET / TAB RENDER ==================== */
  function setNetwork(n) {
    if (S.network === n) return;
    S.network = n;
    onWalletOrNetworkChange();
    renderAll();
  }

  function onWalletOrNetworkChange() {
    const pk = Wallet.publicKey;
    // Init Token-2022 manager & Raydium SDK saat wallet connect / jaringan berubah (seperti useEffect asli)
    S.token2022Manager = pk ? new window.Token2022Manager(RPC_URLS[S.network]) : null;
    S.claimScan = null; S.claimResult = null; S.claimError = ''; // hasil pindai fee tidak berlaku lintas wallet/jaringan
    if (!pk) {
      S.raydiumCpmm = null;
      S.raydiumClmm = null;
      S.raydiumKey = null;
    }
    syncRaydium();
  }

  function renderNetwork() {
    const c = cluster();
    document.body.classList.toggle('mainnet', !isDevnet());
    document.getElementById('hdr-cluster').textContent = c.toUpperCase();
    $$('.net-btn').forEach((b) => b.classList.toggle('active', b.dataset.network === S.network));
    $$('.fn-btn').forEach((b) => b.classList.toggle('active', b.dataset.network === S.network));
    document.getElementById('quick-explorer').href = `https://explorer.solana.com?cluster=${c}`;
    document.getElementById('status-net').textContent = isDevnet() ? 'DEVNET — TEST TOKENS ONLY' : 'MAINNET — REAL SOL FEES';
  }

  function renderWalletStatus() {
    const pk = Wallet.publicKey;
    document.body.classList.toggle('no-wallet', !pk);
    document.getElementById('status-addr').textContent = pk ? shortAddr(pk) : 'DISCONNECTED';
    renderConnect();
  }

  function renderTabs() {
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    $$('.section').forEach((s) => s.classList.toggle('active', s.dataset.panel === S.tab));
  }

  function renderButtons() {
    const pk = !!Wallet.publicKey;
    const C = cluster().toUpperCase();
    const set = (id, disabled, label) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.disabled = !!disabled;
      if (label !== undefined) b.textContent = label;
    };

    set('btn-create', S.createLoading || !pk, S.createLoading ? 'MINING...' : `LAUNCH ${C}`);

    set('btn-clone-fetch', S.cloneFetching || !val('clone-input').trim(), S.cloneFetching ? 'FETCHING...' : 'AMBIL DATA');
    set('btn-clone', S.cloneLoading || !pk, S.cloneLoading ? 'CLONING...' : `CLONE ${C}`);

    set('btn-quote', S.swapLoading || S.swapQuoting || !pk, S.swapLoading || S.swapQuoting ? 'QUOTING...' : 'GET QUOTE');
    set('btn-swap', S.swapLoading || !S.swapQuote || !pk, S.swapLoading ? 'SWAPPING...' : 'EXECUTE SWAP');

    set('btn-liq-create', S.liqLoading || !pk || !val('liq-mintA') || !val('liq-mintB') || !val('liq-priceA'), S.liqLoading ? 'POOLING...' : 'CREATE POOL');
    set('btn-liq-deposit', S.liqLoading || !pk || !val('liq-poolId') || !val('liq-amountA') || !val('liq-amountB'));
    set('btn-liq-withdraw', S.liqLoading || !pk || !val('liq-poolId') || !val('liq-liquidity'));

    set(
      'btn-clmm-create',
      S.clmmLoading || !pk || !val('clmm-mintA') || !val('clmm-mintB') || !val('clmm-initialPrice') || !val('clmm-priceLower') || !val('clmm-priceUpper'),
      S.clmmLoading ? 'POOLING CLMM...' : 'CREATE CLMM POOL'
    );
    set('btn-clmm-deposit', S.clmmLoading || !pk);

    set('btn-t22', S.t22Loading || !pk, S.t22Loading ? 'CREATING...' : 'LAUNCH TOKEN-2022');

    set('btn-auth', S.authLoading || !pk, S.authLoading ? 'REVOKING...' : `REVOKE ${S.authorityType.toUpperCase()}`);
    set('btn-claim-check', S.claimChecking || !val('claim-mint').trim(), S.claimChecking ? 'MEMERIKSA...' : 'CEK FEE');
    set('btn-claim', S.claimLoading || S.claimChecking || !pk || !val('claim-mint').trim(), S.claimLoading ? 'MENGKLAIM...' : 'CLAIM FEE');
  }

  function renderAll() {
    renderNetwork();
    renderWalletStatus();
    renderTabs();
    renderCreate();
    renderClone();
    renderSwap();
    renderLiq();
    renderClmm();
    renderT22();
    renderAuth();
    renderList();
    renderSdkStatus();
  }

  /* ==================== EVENTS ==================== */
  function bindEvents() {
    // Network toggles (header + floating)
    $$('.net-btn, .fn-btn').forEach((b) => b.addEventListener('click', () => setNetwork(b.dataset.network)));

    // Tabs
    $$('.tab').forEach((b) =>
      b.addEventListener('click', () => {
        S.tab = b.dataset.tab;
        renderTabs();
        syncRaydium();
      })
    );

    // Forms
    document.getElementById('form-create').addEventListener('submit', handleCreate);
    document.getElementById('form-clone').addEventListener('submit', handleClone);
    document.getElementById('form-t22').addEventListener('submit', handleCreateToken2022);
    document.getElementById('form-auth').addEventListener('submit', handleRevoke);
    document.getElementById('form-swap').addEventListener('submit', (e) => e.preventDefault());

    // Clone
    document.getElementById('btn-clone-fetch').addEventListener('click', fetchCloneSource);
    document.getElementById('clone-input').addEventListener('input', renderButtons);

    // Swap
    document.getElementById('btn-quote').addEventListener('click', fetchQuote);
    document.getElementById('btn-swap').addEventListener('click', executeSwap);

    // Liquidity CPMM
    document.getElementById('btn-liq-create').addEventListener('click', () => handleLiquidityAction('create'));
    document.getElementById('btn-liq-deposit').addEventListener('click', () => handleLiquidityAction('deposit'));
    document.getElementById('btn-liq-withdraw').addEventListener('click', () => handleLiquidityAction('withdraw'));
    ['liq-mintA', 'liq-mintB', 'liq-priceA', 'liq-amountA', 'liq-amountB', 'liq-poolId', 'liq-liquidity'].forEach((id) =>
      document.getElementById(id).addEventListener('input', renderButtons)
    );

    // Liquidity CLMM
    document.getElementById('btn-clmm-create').addEventListener('click', () => handleClmmAction('createPool'));
    document.getElementById('btn-clmm-deposit').addEventListener('click', () => handleClmmAction('deposit'));
    ['clmm-mintA', 'clmm-mintB', 'clmm-initialPrice', 'clmm-priceLower', 'clmm-priceUpper'].forEach((id) =>
      document.getElementById(id).addEventListener('input', renderButtons)
    );

    // Klaim fee Token-2022
    document.getElementById('btn-claim-check').addEventListener('click', handleClaimCheck);
    document.getElementById('btn-claim').addEventListener('click', handleClaim);
    document.getElementById('claim-mint').addEventListener('input', () => { S.claimScan = null; S.claimResult = null; S.claimError = ''; renderClaim(); });

    // Authority
    $$('.auth-type').forEach((b) => b.addEventListener('click', () => setAuthorityType(b.dataset.type)));
    document.getElementById('auth-type').addEventListener('change', (e) => setAuthorityType(e.target.value));

    // Token list
    document.getElementById('btn-wipe').addEventListener('click', () => {
      S.tokens = [];
      localStorage.removeItem(CFG.STORAGE_TOKENS);
      renderList();
    });

    // Delegasi klik: copy, connect, disconnect, wallet menu, gunakan parameter clone
    document.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        await copyToClipboard(copyBtn.dataset.copy);
        const prev = copyBtn.textContent;
        copyBtn.textContent = '[COPIED]';
        setTimeout(() => { copyBtn.textContent = prev; }, 1000);
        return;
      }
      if (e.target.closest('#btn-connect')) { handleConnect(); return; }
      if (e.target.closest('#btn-disconnect')) { Wallet.disconnect(); return; }
      const walletItem = e.target.closest('[data-wallet]');
      if (walletItem) { connectWith(walletItem.dataset.wallet); return; }
      if (e.target.closest('#btn-use-source')) { useCloneSource(); return; }
      const usePool = e.target.closest('[data-use-pool]');
      if (usePool) { useToken(usePool.dataset.usePool, usePool.dataset.mint, usePool.dataset.decimals); return; }
      const useAuth = e.target.closest('[data-use-auth]');
      if (useAuth) { useToken('auth', useAuth.dataset.useAuth); return; }
      const useClaim = e.target.closest('[data-use-claim]');
      if (useClaim) { useToken('claim', useClaim.dataset.useClaim); return; }
      // klik di luar menu wallet → tutup
      if (S.walletMenuOpen && !e.target.closest('#connect-wrap')) {
        S.walletMenuOpen = false;
        renderConnect();
      }
    });

    // Perubahan state wallet (connect / disconnect / ganti akun)
    Wallet.onChange(() => {
      if (Wallet.connected) S.connectError = null;
      onWalletOrNetworkChange();
      renderAll();
    });
  }

  /* ==================== INIT ==================== */
  loadTokens();
  bindEvents();
  renderAll();
})();

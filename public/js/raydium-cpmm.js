/**
 * raydium-cpmm.js — Port dari lib/raydium-cpmm.ts (implementasi nyata)
 *
 * Raydium CPMM (Constant Product Market Maker) Liquidity Utility
 * Integrasi Raydium SDK v2 untuk operasi liquidity pool on-chain di Devnet & Mainnet:
 *   - createPool  : buat pool CPMM baru + likuiditas awal
 *   - deposit     : tambah likuiditas (ADD LIQUIDITY)
 *   - withdraw    : tarik likuiditas (REMOVE LIQUIDITY)
 * Non-custodial: semua transaksi ditandatangani via wallet (Phantom/Solflare).
 *
 * Membutuhkan bundle vendor/raydium-sdk.js (window.RaydiumSDK) — dimuat lazy oleh app.js.
 */
(function (root) {
  'use strict';

  const web3 = root.solanaWeb3;
  const { Connection, PublicKey } = web3;

  function sdk() {
    if (!root.RaydiumSDK) throw new Error('Raydium SDK belum dimuat');
    return root.RaydiumSDK;
  }

  // Program ID Raydium CPMM (diambil dari SDK agar selalu sinkron dengan deployment resmi)
  const RAYDIUM_CPMM_PROGRAM_IDS = {
    get devnet() { return sdk().DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58(); },
    get 'mainnet-beta'() { return sdk().CREATE_CPMM_POOL_PROGRAM.toBase58(); },
  };

  const DEFAULT_SLIPPAGE_BPS = 100; // 1%

  function isPositive(v) {
    if (v === undefined || v === null || v === '') return false;
    const n = Number(v);
    return isFinite(n) && n > 0;
  }

  /** UI amount (string/number/Decimal) -> BN satuan terkecil */
  function toRaw(uiAmount, decimals) {
    const { Decimal, BN } = sdk();
    const d = uiAmount instanceof Decimal ? uiAmount : new Decimal(String(uiAmount));
    return new BN(d.mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN));
  }

  /** BN satuan terkecil -> string UI */
  function toUi(raw, decimals) {
    const { Decimal } = sdk();
    return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toString();
  }

  /**
   * SDK execute() pada jalur wallet (signAllTransactions) hanya mengirim transaksi tanpa menunggu konfirmasi,
   * jadi konfirmasi dilakukan di sini (polling status, tanpa websocket) — menampilkan error on-chain bila gagal.
   */
  async function waitForConfirmation(connection, signature, timeoutMs) {
    const limit = timeoutMs || 90000;
    const start = Date.now();
    while (Date.now() - start < limit) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const st = value && value[0];
      if (st) {
        if (st.err) throw new Error('Transaksi gagal on-chain: ' + JSON.stringify(st.err) + ' (' + signature + ')');
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return signature;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Timeout menunggu konfirmasi transaksi ' + signature);
  }

  /** Jalankan execute() SDK dengan preflight (error simulasi terbaca) lalu tunggu konfirmasi */
  async function executeAndConfirm(connection, execute) {
    const { txId } = await execute({ skipPreflight: false });
    if (!txId) throw new Error('Transaksi tidak terkirim');
    await waitForConfirmation(connection, txId);
    return txId;
  }

  class RaydiumCpmm {
    constructor(cluster, rpcUrl) {
      this.cluster = cluster || 'devnet';
      this.raydium = null;
      this.connection = new Connection(
        rpcUrl || (this.cluster === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'),
        'confirmed'
      );
    }

    get isDevnet() {
      return this.cluster === 'devnet';
    }

    get programId() {
      const { DEVNET_PROGRAM_ID, CREATE_CPMM_POOL_PROGRAM } = sdk();
      return this.isDevnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM;
    }

    get poolFeeAccount() {
      const { DEVNET_PROGRAM_ID, CREATE_CPMM_POOL_FEE_ACC } = sdk();
      return this.isDevnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : CREATE_CPMM_POOL_FEE_ACC;
    }

    /**
     * Initialize Raydium SDK dengan wallet
     * @param {PublicKey} walletPublicKey
     * @param {(tx, conn) => Promise<string>} sendTransaction
     * @param {(txs) => Promise<any[]>} signAllTransactions hook tanda tangan wallet untuk SDK (execute())
     */
    async init(walletPublicKey, sendTransaction, signAllTransactions) {
      const { Raydium, DEV_API_URLS } = sdk();
      this.raydium = await Raydium.load({
        connection: this.connection,
        owner: walletPublicKey,
        cluster: this.isDevnet ? 'devnet' : 'mainnet', // tipe Cluster SDK: 'mainnet' | 'devnet'
        signAllTransactions,
        disableFeatureCheck: true,
        disableLoadToken: true, // info mint diambil per-mint (API/on-chain) via getTokenInfo
        urlConfigs: this.isDevnet ? Object.assign({}, DEV_API_URLS) : undefined,
      });

      // Attach custom sendTransaction so SDK can sign+send via wallet
      this.raydium._sendTransaction = sendTransaction;
    }

    _assertReady() {
      if (!this.raydium) throw new Error('Raydium SDK not initialized');
    }

    /** Segarkan cache token account SDK (akun LP/ATA baru tidak terlihat jika cache lama dipakai) */
    async _refreshTokenAccounts() {
      try {
        await this.raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
      } catch (_) {
        /* abaikan: SDK akan mengambil ulang saat dibutuhkan */
      }
    }

    /** Info mint (address, programId, decimals) dari API Raydium atau langsung on-chain */
    async getMintInfo(mint) {
      this._assertReady();
      let pk;
      try {
        pk = new PublicKey(mint);
      } catch (_) {
        throw new Error(`Alamat mint tidak valid: ${mint}`);
      }
      let info = null;
      try {
        info = await this.raydium.token.getTokenInfo(pk); // API Raydium → fallback on-chain
      } catch (e) {
        if (!/not found/i.test(String(e && e.message))) throw e;
      }
      if (!info || info.decimals === undefined || info.decimals === null) {
        throw new Error(`Mint ${pk.toBase58()} tidak ditemukan di ${this.cluster} (periksa jaringan & alamat)`);
      }
      return info;
    }

    /** Daftar fee config CPMM (devnet: id di-remap ke PDA program devnet, sesuai contoh resmi SDK) */
    async getFeeConfigs() {
      this._assertReady();
      const { getCpmmPdaAmmConfigId, DEVNET_PROGRAM_ID } = sdk();
      const configs = await this.raydium.api.getCpmmConfigs();
      if (!configs || !configs.length) throw new Error('Fee config CPMM tidak tersedia dari API Raydium');
      if (this.isDevnet) {
        configs.forEach((config) => {
          config.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, config.index).publicKey.toBase58();
        });
      }
      return configs;
    }

    /**
     * Create a new CPMM liquidity pool (+ likuiditas awal)
     * @param {object} params
     *   tokenA, tokenB : alamat mint
     *   priceA         : harga 1 token A dalam token B (PRICE A vs B)
     *   amountA/amountB: likuiditas awal (UI). Jika salah satu kosong, dihitung dari priceA.
     *   startTime      : unix detik (default 0 = langsung aktif)
     *   feeConfigIndex : index fee config Raydium (default 0 = trade fee 0.25%)
     */
    async createPool(params) {
      this._assertReady();
      const { BN, TxVersion, Decimal } = sdk();

      const [mintA, mintB] = await Promise.all([this.getMintInfo(params.tokenA), this.getMintInfo(params.tokenB)]);
      if (mintA.address === mintB.address) throw new Error('Mint A dan Mint B tidak boleh sama');

      const price = new Decimal(String(params.priceA));
      if (!price.isFinite() || price.lte(0)) throw new Error('Price A harus lebih besar dari 0');

      const hasA = isPositive(params.amountA);
      const hasB = isPositive(params.amountB);
      if (!hasA && !hasB) throw new Error('Isi AMOUNT A (dan/atau AMOUNT B) sebagai likuiditas awal pool');
      let uiA = hasA ? new Decimal(String(params.amountA)) : null;
      let uiB = hasB ? new Decimal(String(params.amountB)) : null;
      if (!uiB) uiB = uiA.mul(price); // B = A × harga
      if (!uiA) uiA = uiB.div(price); // A = B ÷ harga

      const mintAAmount = toRaw(uiA, mintA.decimals);
      const mintBAmount = toRaw(uiB, mintB.decimals);
      if (mintAAmount.isZero() || mintBAmount.isZero()) throw new Error('Jumlah likuiditas awal terlalu kecil untuk decimals token');

      const feeConfigs = await this.getFeeConfigs();
      await this._refreshTokenAccounts();
      const wantIndex = params.feeConfigIndex != null ? params.feeConfigIndex : 0;
      const feeConfig = feeConfigs.find((c) => c.index === wantIndex) || feeConfigs[0];

      const { execute, extInfo } = await this.raydium.cpmm.createPool({
        programId: this.programId,
        poolFeeAccount: this.poolFeeAccount,
        mintA,
        mintB,
        mintAAmount,
        mintBAmount,
        startTime: new BN(params.startTime != null ? params.startTime : 0),
        feeConfig,
        associatedOnly: false,
        ownerInfo: { useSOLBalance: true },
        txVersion: TxVersion.V0,
      });

      const txId = await executeAndConfirm(this.connection, execute);

      return {
        poolId: extInfo.address.poolId.toBase58(),
        signature: txId,
        lpMint: extInfo.address.lpMint ? extInfo.address.lpMint.toBase58() : '',
        amountA: uiA.toString(),
        amountB: uiB.toString(),
        price: uiB.div(uiA).toString(),
        tradeFeeRate: feeConfig.tradeFeeRate, // satuan 1e-6 (2500 = 0.25%)
      };
    }

    /**
     * Add liquidity to an existing CPMM pool
     * @param {object} params { poolId, amountA, amountB (UI; salah satu jadi basis, lainnya batas maks), mintA (opsional: orientasi A/B form), slippageBps }
     */
    async deposit(params) {
      this._assertReady();
      const { Percent, TxVersion, Decimal, BN } = sdk();

      const { poolInfo, poolKeys, rpcData } = await this.raydium.cpmm.getPoolInfoFromRpc(String(params.poolId));
      await this._refreshTokenAccounts();
      const decA = poolInfo.mintA.decimals;
      const decB = poolInfo.mintB.decimals;
      // Orientasi: program CPMM mengurutkan mint; jika MINT A di form = mint B pool, jumlah A/B user ditukar
      const swapped = this._isSwapped(poolInfo, params.mintA);
      const userHasA = isPositive(params.amountA);
      const userHasB = isPositive(params.amountB);
      if (!userHasA && !userHasB) throw new Error('AMOUNT A / AMOUNT B harus lebih besar dari 0');

      // Basis perhitungan = AMOUNT A user (jika diisi), AMOUNT B menjadi batas maksimum pasangan; sebaliknya jika hanya B
      const baseIsUserA = userHasA;
      const baseIn = swapped ? !baseIsUserA : baseIsUserA; // sisi pool yang menjadi basis
      const baseUi = baseIsUserA ? params.amountA : params.amountB;
      const otherUi = baseIsUserA ? params.amountB : params.amountA;
      const labelOther = baseIsUserA ? 'B' : 'A';
      const inputAmount = toRaw(baseUi, baseIn ? decA : decB);
      if (inputAmount.isZero()) throw new Error('Jumlah terlalu kecil untuk decimals token');
      const slippageBps = params.slippageBps != null ? params.slippageBps : DEFAULT_SLIPPAGE_BPS;
      const slippage = new Percent(slippageBps, 10000);

      // Estimasi kebutuhan token pasangan (rasio reserve pool) + slippage, divalidasi terhadap jumlah pasangan yang diisi
      let needOther = null;
      if (rpcData && rpcData.baseReserve && rpcData.quoteReserve && !rpcData.baseReserve.isZero() && !rpcData.quoteReserve.isZero()) {
        needOther = baseIn
          ? inputAmount.mul(rpcData.quoteReserve).div(rpcData.baseReserve)
          : inputAmount.mul(rpcData.baseReserve).div(rpcData.quoteReserve);
        const needOtherMax = needOther.mul(new BN(10000 + slippageBps)).div(new BN(10000));
        if (isPositive(otherUi)) {
          const maxOther = toRaw(otherUi, baseIn ? decB : decA);
          if (needOtherMax.gt(maxOther)) {
            throw new Error(
              `AMOUNT ${labelOther} tidak cukup: dibutuhkan ≈ ${toUi(needOtherMax, baseIn ? decB : decA)} ` +
                `(rasio pool + slippage ${new Decimal(slippageBps).div(100).toString()}%)`
            );
          }
        }
      }

      const { execute } = await this.raydium.cpmm.addLiquidity({
        poolInfo,
        poolKeys,
        inputAmount,
        slippage,
        baseIn,
        txVersion: TxVersion.V0,
      });
      const txId = await executeAndConfirm(this.connection, execute);

      const usedA = baseIn ? toUi(inputAmount, decA) : needOther ? toUi(needOther, decA) : '';
      const usedB = baseIn ? (needOther ? toUi(needOther, decB) : '') : toUi(inputAmount, decB);
      return {
        signature: txId,
        poolId: poolInfo.id,
        mintA: poolInfo.mintA.address,
        mintB: poolInfo.mintB.address,
        // dalam istilah user (MINT A / MINT B di form)
        amountA: swapped ? usedB : usedA,
        amountB: swapped ? usedA : usedB,
      };
    }

    /** true jika MINT A yang diisi user adalah mint B pool (urutan mint ditukar oleh program) */
    _isSwapped(poolInfo, userMintA) {
      if (!userMintA) return false;
      const m = String(userMintA);
      return poolInfo.mintB.address === m && poolInfo.mintA.address !== m;
    }

    /**
     * Remove liquidity from a CPMM pool
     * @param {object} params { poolId, liquidity (UI LP token), minAmountA, minAmountB (UI; 0 = slippage default 1%), mintA (opsional: orientasi A/B form) }
     */
    async withdraw(params) {
      this._assertReady();
      const { Percent, TxVersion, BN } = sdk();
      if (!isPositive(params.liquidity)) throw new Error('LIQUIDITY (LP) harus lebih besar dari 0');

      const { poolInfo, poolKeys, rpcData } = await this.raydium.cpmm.getPoolInfoFromRpc(String(params.poolId));
      await this._refreshTokenAccounts();
      const decA = poolInfo.mintA.decimals;
      const decB = poolInfo.mintB.decimals;
      const swapped = this._isSwapped(poolInfo, params.mintA);
      const lpDecimals = poolInfo.lpMint && poolInfo.lpMint.decimals != null ? poolInfo.lpMint.decimals : rpcData.lpDecimals;
      const lpAmount = toRaw(params.liquidity, lpDecimals);
      if (lpAmount.isZero()) throw new Error('LIQUIDITY (LP) terlalu kecil untuk decimals LP token');

      // Estimasi hasil penarikan: lp × reserve / total LP (rumus yang sama dengan SDK)
      const lpSupply = rpcData.lpAmount;
      const expA = lpAmount.mul(rpcData.baseReserve).div(lpSupply);
      const expB = lpAmount.mul(rpcData.quoteReserve).div(lpSupply);

      // MIN A / MIN B dalam istilah user -> sisi pool
      const minUiA = swapped ? params.minAmountB : params.minAmountA;
      const minUiB = swapped ? params.minAmountA : params.minAmountB;
      const labelA = swapped ? 'MIN B' : 'MIN A';
      const labelB = swapped ? 'MIN A' : 'MIN B';
      let slippage = new Percent(DEFAULT_SLIPPAGE_BPS, 10000);
      const minA = isPositive(minUiA) ? toRaw(minUiA, decA) : new BN(0);
      const minB = isPositive(minUiB) ? toRaw(minUiB, decB) : new BN(0);
      if (!minA.isZero() || !minB.isZero()) {
        if (minA.gt(expA)) throw new Error(`${labelA} (${minUiA}) melebihi estimasi penarikan ${toUi(expA, decA)}`);
        if (minB.gt(expB)) throw new Error(`${labelB} (${minUiB}) melebihi estimasi penarikan ${toUi(expB, decB)}`);
        // Terjemahkan MIN A/MIN B menjadi slippage SDK: min = (1 - slippage) × estimasi
        const DEN = new BN(1000000);
        const ratioA = expA.isZero() ? new BN(0) : minA.mul(DEN).div(expA);
        const ratioB = expB.isZero() ? new BN(0) : minB.mul(DEN).div(expB);
        const ratio = BN.max(ratioA, ratioB);
        slippage = new Percent(DEN.sub(ratio), DEN);
      }

      const { execute } = await this.raydium.cpmm.withdrawLiquidity({
        poolInfo,
        poolKeys,
        lpAmount,
        slippage,
        txVersion: TxVersion.V0,
      });
      const txId = await executeAndConfirm(this.connection, execute);

      const uiA = toUi(expA, decA);
      const uiB = toUi(expB, decB);
      return {
        signature: txId,
        poolId: poolInfo.id,
        amountA: swapped ? uiB : uiA,
        amountB: swapped ? uiA : uiB,
      };
    }

    /**
     * Fetch pool info by pool ID
     */
    async getPoolInfo(poolId) {
      this._assertReady();
      try {
        const { poolInfo } = await this.raydium.cpmm.getPoolInfoFromRpc(String(poolId));
        return poolInfo;
      } catch (_) {
        return null;
      }
    }
  }

  RaydiumCpmm.RAYDIUM_CPMM_PROGRAM_IDS = RAYDIUM_CPMM_PROGRAM_IDS;
  RaydiumCpmm.toRaw = toRaw;
  RaydiumCpmm.toUi = toUi;
  RaydiumCpmm.waitForConfirmation = waitForConfirmation;
  root.RaydiumCpmm = RaydiumCpmm;
})(window);

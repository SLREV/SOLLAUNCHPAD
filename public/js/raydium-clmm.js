/**
 * raydium-clmm.js — Port dari lib/raydium-clmm.ts (implementasi nyata)
 *
 * Raydium CLMM (Concentrated Liquidity Market Maker) Utility
 * Dukung pembuatan pool CLMM dengan rentang harga (tick range) untuk leverage virtual:
 *   - createPool : buat pool CLMM baru (+ buka posisi likuiditas di rentang harga jika AMOUNT diisi)
 *   - deposit    : tambah likuiditas (buka posisi baru) pada pool CLMM yang sudah ada
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

  const DEFAULT_SLIPPAGE_BPS = 100; // 1%

  /**
   * Pemetaan nilai pilihan FEE RATE di form -> tradeFeeRate Raydium (satuan 1e-6):
   *   10    -> 100   (0.01%)
   *   25    -> 500   (0.05%)
   *   2500  -> 2500  (0.25%) — Recommended
   *   10000 -> 10000 (1%)
   */
  const FEE_RATE_MAP = { 10: 100, 25: 500, 2500: 2500, 10000: 10000 };

  function isPositive(v) {
    if (v === undefined || v === null || v === '') return false;
    try {
      const { Decimal } = sdk();
      const value = v instanceof Decimal ? v : new Decimal(String(v));
      return value.isFinite() && value.gt(0);
    } catch (_) {
      return false;
    }
  }

  function toRaw(uiAmount, decimals) {
    const { BN } = sdk();
    return new BN(root.TokenAmounts.toBaseUnits(String(uiAmount), decimals).toString());
  }

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

  class RaydiumClmm {
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
      const { DEVNET_PROGRAM_ID, CLMM_PROGRAM_ID } = sdk();
      return this.isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
    }

    /**
     * Inisialisasi SDK dengan wallet
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

      this.raydium._sendTransaction = sendTransaction;
    }

    _assertReady() {
      if (!this.raydium) throw new Error('Raydium CLMM SDK not initialized');
    }

    /** Segarkan cache token account SDK (ATA baru tidak terlihat jika cache lama dipakai) */
    async _refreshTokenAccounts() {
      try {
        await this.raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
      } catch (_) {
        /* abaikan: SDK akan mengambil ulang saat dibutuhkan */
      }
    }

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

    /** Daftar AmmConfig CLMM resmi Raydium (devnet/mainnet mengikuti cluster SDK) */
    async getAmmConfigs() {
      this._assertReady();
      const configs = await this.raydium.api.getClmmConfigs();
      if (!configs || !configs.length) throw new Error('AmmConfig CLMM tidak tersedia dari API Raydium');
      return configs;
    }

    /**
     * Pilih AmmConfig berdasarkan fee rate pilihan form (lihat FEE_RATE_MAP).
     * Jika tidak ada yang persis sama, dipilih yang paling dekat.
     */
    async getAmmConfig(feeRate) {
      const target = FEE_RATE_MAP[feeRate] != null ? FEE_RATE_MAP[feeRate] : Number(feeRate) || 2500;
      const configs = await this.getAmmConfigs();
      let cfg = configs.find((c) => c.tradeFeeRate === target);
      if (!cfg) {
        cfg = configs.reduce(
          (best, c) => (Math.abs(c.tradeFeeRate - target) < Math.abs(best.tradeFeeRate - target) ? c : best),
          configs[0]
        );
      }
      return cfg;
    }

    /** Kompatibilitas: id AmmConfig untuk fee rate tertentu */
    async getAmmConfigId(feeRate) {
      const cfg = await this.getAmmConfig(feeRate);
      return cfg.id;
    }

    /**
     * Konversi harga desimal (B per A) ke tick CLMM.
     * @param {number|string|Decimal} price
     * @param {number} decimalsA
     * @param {number} decimalsB
     * @param {number} [tickSpacing] jika diisi, tick dibulatkan ke kelipatan tickSpacing
     */
    priceToTick(price, decimalsA, decimalsB, tickSpacing) {
      const { TickUtil, Decimal } = sdk();
      const p = price instanceof Decimal ? price : new Decimal(String(price));
      const tick = TickUtil.priceToTick(p, decimalsA, decimalsB);
      return tickSpacing ? TickUtil.toTickIndex(tick, tickSpacing) : tick;
    }

    /** Konversi tick -> harga (B per A) */
    tickToPrice(tick, decimalsA, decimalsB) {
      const { TickUtil } = sdk();
      return TickUtil.tickToPrice(tick, decimalsA, decimalsB);
    }

    /**
     * Ambil data pool CLMM langsung dari RPC (tanpa API) dalam bentuk yang dibutuhkan
     * openPositionFromBase & PoolUtils: { poolInfo, poolKeys, rpcData }.
     * (getPoolInfoFromRpc SDK gagal pada pool baru yang belum punya tick array.)
     */
    async _fetchPool(poolId) {
      this._assertReady();
      const { fetchMultipleMintInfos } = sdk();
      let simple;
      try {
        simple = await this.raydium.clmm.getSimplePoolInfo(poolId);
      } catch (e) {
        throw new Error(`Pool CLMM tidak ditemukan: ${poolId}`);
      }
      const { poolInfo: base, rpcData } = simple;
      const mintA = new PublicKey(base.mintA.address);
      const mintB = new PublicKey(base.mintB.address);
      let mintInfos = {};
      try {
        mintInfos = await fetchMultipleMintInfos({ connection: this.connection, mints: [mintA, mintB] });
      } catch (_) {
        mintInfos = {};
      }
      const ext = (addr) => ({ feeConfig: mintInfos[addr] ? mintInfos[addr].feeConfig : undefined });
      const poolInfo = Object.assign({}, base, {
        price: rpcData.currentPrice,
        mintA: Object.assign({}, base.mintA, { extensions: ext(base.mintA.address) }),
        mintB: Object.assign({}, base.mintB, { extensions: ext(base.mintB.address) }),
      });
      const poolKeys = { vault: { A: rpcData.vaultA.toBase58(), B: rpcData.vaultB.toBase58() } };
      return { poolInfo, poolKeys, rpcData };
    }

    /**
     * Hitung rentang tick dari rentang harga yang diisi user.
     * Program CLMM mengurutkan mint (mintA < mintB); jika urutan pool terbalik dari input user,
     * harga user (A vs B) dibalik menjadi 1/harga.
     */
    _range(poolInfo, userMintA, priceLower, priceUpper) {
      const { Decimal } = sdk();
      const decA = poolInfo.mintA.decimals;
      const decB = poolInfo.mintB.decimals;
      const tickSpacing = poolInfo.config.tickSpacing;
      const swapped = !!userMintA && poolInfo.mintB.address === String(userMintA) && poolInfo.mintA.address !== String(userMintA);

      let lo = new Decimal(String(priceLower));
      let hi = new Decimal(String(priceUpper));
      if (!lo.isFinite() || !hi.isFinite() || lo.lte(0) || hi.lte(0)) throw new Error('Price lower/upper harus lebih besar dari 0');
      if (lo.gte(hi)) throw new Error('PRICE LOWER harus lebih kecil dari PRICE UPPER');
      if (swapped) {
        const newLo = new Decimal(1).div(hi);
        const newHi = new Decimal(1).div(lo);
        lo = newLo;
        hi = newHi;
      }

      let tickLower = this.priceToTick(lo, decA, decB, tickSpacing);
      let tickUpper = this.priceToTick(hi, decA, decB, tickSpacing);
      if (tickLower > tickUpper) {
        const t = tickLower;
        tickLower = tickUpper;
        tickUpper = t;
      }
      if (tickLower === tickUpper) tickUpper += tickSpacing;

      return { swapped, tickLower, tickUpper, tickSpacing };
    }

    /**
     * Buka posisi likuiditas (NFT posisi Token-2022) pada pool.
     * amountA/amountB dalam istilah user (Mint A/Mint B di form).
     */
    async openPosition(opts) {
      this._assertReady();
      const { PoolUtils, TxVersion, BN } = sdk();
      const { poolInfo, poolKeys, swapped, tickLower, tickUpper } = opts;
      const slippageBps = opts.slippageBps != null ? opts.slippageBps : DEFAULT_SLIPPAGE_BPS;

      const userHasA = isPositive(opts.amountA);
      const userHasB = isPositive(opts.amountB);
      if (!userHasA && !userHasB) throw new Error('Isi AMOUNT A atau AMOUNT B untuk menambah likuiditas');

      // Basis = AMOUNT A user (jika diisi), AMOUNT B menjadi batas maksimum pasangan; sebaliknya jika hanya B
      const baseIsUserA = userHasA;
      const inputA = swapped ? !baseIsUserA : baseIsUserA; // sisi pool yang menjadi basis
      const baseUi = baseIsUserA ? opts.amountA : opts.amountB;
      const otherUi = baseIsUserA ? opts.amountB : opts.amountA;
      const labelOther = baseIsUserA ? 'B' : 'A';
      const decA = poolInfo.mintA.decimals;
      const decB = poolInfo.mintB.decimals;
      const baseAmount = toRaw(baseUi, inputA ? decA : decB);
      if (baseAmount.isZero()) throw new Error('Jumlah terlalu kecil untuk decimals token');

      await this._refreshTokenAccounts();
      const epochInfo = await this.raydium.fetchEpochInfo();
      const est = await PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo,
        inputA,
        tickLower,
        tickUpper,
        amount: baseAmount,
        slippage: slippageBps / 10000,
        add: true,
        epochInfo,
        amountHasFee: true,
      });
      // Catatan: amountSlippageA/B SDK = jumlah × (1 - slippage) (semantik penarikan), jadi batas maksimum
      // untuk penambahan likuiditas dihitung sendiri: jumlah pasangan × (1 + slippage) — sama seperti demo resmi SDK.
      const otherExact = inputA ? est.amountB.amount : est.amountA.amount;
      const otherAmountMax = otherExact.muln(10000 + slippageBps).divn(10000);

      // Validasi terhadap jumlah pasangan yang diisi user (jika ada)
      if (isPositive(otherUi)) {
        const otherRaw = toRaw(otherUi, inputA ? decB : decA);
        if (otherAmountMax.gt(otherRaw)) {
          throw new Error(
            `AMOUNT ${labelOther} tidak cukup untuk rentang ini: dibutuhkan ≈ ${toUi(otherAmountMax, inputA ? decB : decA)} ` +
              `(termasuk slippage ${slippageBps / 100}%)`
          );
        }
      }

      const { execute, extInfo } = await this.raydium.clmm.openPositionFromBase({
        poolInfo,
        poolKeys,
        tickLower,
        tickUpper,
        base: inputA ? 'MintA' : 'MintB',
        ownerInfo: { useSOLBalance: true },
        baseAmount,
        otherAmountMax,
        liquidity: new BN(0), // 0 = kontrak menghitung likuiditas dari baseAmount
        nft2022: true,
        txVersion: TxVersion.V0,
      });
      const txId = await executeAndConfirm(this.connection, execute);

      const usedA = toUi(est.amountA.amount, decA);
      const usedB = toUi(est.amountB.amount, decB);
      return {
        signature: txId,
        nftMint: extInfo.nftMint.toBase58(),
        liquidity: est.liquidity.toString(),
        // kembali ke istilah user
        amountA: swapped ? usedB : usedA,
        amountB: swapped ? usedA : usedB,
      };
    }

    /**
     * Buat pool CLMM baru dengan rentang harga (virtual leverage).
     * Jika AMOUNT A / AMOUNT B diisi, posisi likuiditas langsung dibuka pada rentang [priceLower, priceUpper]
     * (transaksi ke-2, ditandatangani wallet).
     */
    async createPool(params) {
      this._assertReady();
      const { Decimal, TxVersion } = sdk();

      const [mint1, mint2] = await Promise.all([this.getMintInfo(params.mintA), this.getMintInfo(params.mintB)]);
      if (mint1.address === mint2.address) throw new Error('Mint A dan Mint B tidak boleh sama');

      const initialPrice = new Decimal(String(params.initialPrice));
      if (!initialPrice.isFinite() || initialPrice.lte(0)) throw new Error('Harga awal harus lebih besar dari 0');
      const lower = new Decimal(String(params.priceLower));
      const upper = new Decimal(String(params.priceUpper));
      if (!lower.isFinite() || !upper.isFinite() || lower.lte(0) || upper.lte(0)) throw new Error('Price lower/upper harus lebih besar dari 0');
      if (lower.gte(upper)) throw new Error('PRICE LOWER harus lebih kecil dari PRICE UPPER');

      const cfg = await this.getAmmConfig(params.feeRate);
      const ammConfig = Object.assign({}, cfg, { id: new PublicKey(cfg.id), fundOwner: '', description: cfg.description || '' });

      const { execute, extInfo } = await this.raydium.clmm.createPool({
        programId: this.programId,
        mint1,
        mint2,
        ammConfig,
        initialPrice,
        txVersion: TxVersion.V0,
      });
      const txId = await executeAndConfirm(this.connection, execute);

      const poolId = String((extInfo.mockPoolInfo && extInfo.mockPoolInfo.id) || extInfo.address.id);
      const result = {
        poolId,
        signature: txId,
        tickLower: null,
        tickUpper: null,
        tickSpacing: null,
        tradeFeeRate: cfg.tradeFeeRate, // satuan 1e-6
        ammConfigId: String(cfg.id),
        positionSignature: '',
        nftMint: '',
        positionError: '',
      };

      try {
        const range = this._range(extInfo.mockPoolInfo, mint1.address, params.priceLower, params.priceUpper);
        result.tickLower = range.tickLower;
        result.tickUpper = range.tickUpper;
        result.tickSpacing = range.tickSpacing;

        if (isPositive(params.inputAmountA) || isPositive(params.inputAmountB)) {
          // Pool sudah final di chain. Jika posisi gagal, kembalikan detail pool agar pengguna dapat melanjutkan,
          // bukan menyembunyikan transaksi pertama dan mendorong pembuatan ulang pool.
          const data = await this._fetchPool(poolId);
          const pos = await this.openPosition({
            poolInfo: data.poolInfo,
            poolKeys: data.poolKeys,
            swapped: range.swapped,
            tickLower: range.tickLower,
            tickUpper: range.tickUpper,
            amountA: params.inputAmountA,
            amountB: params.inputAmountB,
            slippageBps: params.slippageBps,
          });
          result.positionSignature = pos.signature;
          result.nftMint = pos.nftMint;
          result.amountA = pos.amountA;
          result.amountB = pos.amountB;
        }
      } catch (e) {
        result.positionError = (e && e.message) || 'Initial liquidity position failed';
      }

      return result;
    }

    /**
     * Tambah likuiditas ke pool CLMM yang sudah ada (buka posisi baru pada rentang harga form)
     * @param {object} params { poolId, priceLower, priceUpper, amountA, amountB, mintA (opsional, orientasi harga), slippageBps }
     */
    async deposit(params) {
      this._assertReady();
      const data = await this._fetchPool(String(params.poolId));
      const range = this._range(data.poolInfo, params.mintA, params.priceLower, params.priceUpper);
      const pos = await this.openPosition({
        poolInfo: data.poolInfo,
        poolKeys: data.poolKeys,
        swapped: range.swapped,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amountA: params.amountA,
        amountB: params.amountB,
        slippageBps: params.slippageBps,
      });
      return Object.assign({ poolId: data.poolInfo.id, tickLower: range.tickLower, tickUpper: range.tickUpper }, pos);
    }

    /**
     * Info pool CLMM (null jika tidak ditemukan)
     */
    async getPoolInfo(poolId) {
      this._assertReady();
      try {
        const { poolInfo } = await this._fetchPool(String(poolId));
        return poolInfo;
      } catch (_) {
        return null;
      }
    }
  }

  RaydiumClmm.FEE_RATE_MAP = FEE_RATE_MAP;
  RaydiumClmm.toRaw = toRaw;
  RaydiumClmm.toUi = toUi;
  RaydiumClmm.waitForConfirmation = waitForConfirmation;
  root.RaydiumClmm = RaydiumClmm;
})(window);

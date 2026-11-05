/**
 * token-2022.js — Port dari lib/token-2022.ts
 *
 * Token-2022 Transfer Fee Utility
 * Membuat SPL Token-2022 dengan transfer fee konfigurasi.
 * Setiap kali token ditransfer, fee otomatis dipotong (withheld) sesuai basis points.
 * Non-custodial: private key & fee authority tetap di wallet Anda.
 */
(function (root) {
  'use strict';

  const web3 = root.solanaWeb3;
  const SplToken = root.SplToken;
  const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = web3;

  // u64 maksimum = "tanpa cap maksimal" (MAX FEE 0 di form berarti tidak ada batas, bukan fee 0)
  const U64_MAX = BigInt('18446744073709551615');

  class Token2022Manager {
    constructor(rpcUrl) {
      this.connection = new Connection(rpcUrl || 'https://api.devnet.solana.com', 'confirmed');
    }

    /**
     * Buat Token-2022 dengan transfer fee
     * @param {object} params {name, symbol, decimals, supply, transferFeeBasisPoints, transferFeeMax, feeRecipient}
     * @param {PublicKey} payer wallet yang connect (creator)
     * @param {(tx: Transaction) => Promise<string>} sendTransaction
     */
    async createTokenWithFee(params, payer, sendTransaction) {
      const decimals = params.decimals;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Decimals must be from 0 to 18');
      const amount = root.TokenAmounts.toBaseUnits(params.supply, decimals);
      if (amount <= 0n) throw new Error('Initial supply must be greater than zero');
      const basisPoints = Number(params.transferFeeBasisPoints);
      if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
        throw new Error('Transfer fee basis points must be from 0 to 10000');
      }
      // Withdraw-withheld authority is separate from permission to change the fee configuration.
      const feeRecipient = params.feeRecipient ? new PublicKey(params.feeRecipient) : payer;
      const feeConfigAuthorityMode = params.feeConfigAuthority === 'creator' ? 'creator' : 'immutable';
      const feeConfigAuthority = feeConfigAuthorityMode === 'creator' ? payer : null;
      const maxFeeInput = root.TokenAmounts.toUnsignedInteger(params.transferFeeMax || '0', U64_MAX, 'Maximum fee');
      const maxFee = maxFeeInput > 0n ? maxFeeInput : U64_MAX;

      // Mint Token-2022 dengan extension TransferFeeConfig butuh ruang lebih besar dari SPL standar (82 byte)
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;
      const mintLen = SplToken.getMintLen([SplToken.ExtensionType.TransferFeeConfig]); // 278 byte
      const rent = await this.connection.getMinimumBalanceForRentExemption(mintLen);
      const ata = await SplToken.getAssociatedTokenAddress(mint, payer, false, SplToken.TOKEN_2022_PROGRAM_ID);

      const tx = new Transaction();
      tx.feePayer = payer;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      tx.add(
        // 1. Buat mint account (Token-2022)
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: mint,
          lamports: rent,
          space: mintLen,
          programId: SplToken.TOKEN_2022_PROGRAM_ID,
        }),
        // 2. Inisialisasi transfer fee config — WAJIB sebelum InitializeMint (aturan Token-2022 extension)
        //    Basis points: 10000 = 100%, 100 = 1%, 10 = 0.1%
        SplToken.createInitializeTransferFeeConfigInstruction(
          mint,
          feeConfigAuthority, // null makes the fee configuration immutable from creation
          feeRecipient, // withdraw withheld authority (berhak menarik fee yang tertahan)
          basisPoints,
          maxFee,
          SplToken.TOKEN_2022_PROGRAM_ID
        ),
        // 3. Inisialisasi mint dengan Token-2022 program
        SplToken.createInitializeMintInstruction(mint, decimals, payer, null, SplToken.TOKEN_2022_PROGRAM_ID),
        // 4. Buat ATA untuk creator
        SplToken.createAssociatedTokenAccountInstruction(payer, ata, payer, mint, SplToken.TOKEN_2022_PROGRAM_ID),
        // 5. Mint supply awal ke creator
        SplToken.createMintToInstruction(mint, ata, payer, amount, [], SplToken.TOKEN_2022_PROGRAM_ID)
      );

      // 6. Metadata Metaplex (nama & symbol) untuk mint Token-2022 — instruksi Create V1 (Fungible)
      const name = (params.name || '').trim();
      const symbol = (params.symbol || '').trim();
      if ((name || symbol) && root.Metaplex) {
        root.Metaplex.validateData({ name, symbol, uri: '' });
        tx.add(
          root.Metaplex.createV1Instruction({
            mint,
            authority: payer,
            payer,
            updateAuthority: payer,
            name,
            symbol,
            uri: '',
            tokenProgram: SplToken.TOKEN_2022_PROGRAM_ID,
          })
        );
      }

      // Akun mint baru wajib ikut menandatangani (createAccount) — lalu wallet menandatangani sebagai fee payer
      tx.partialSign(mintKeypair);

      const signature = await sendTransaction(tx);
      await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

      return {
        mint: mint.toString(),
        signature,
        feeRecipient: feeRecipient.toString(),
        feeConfigAuthority: feeConfigAuthority ? feeConfigAuthority.toString() : null,
        maximumFee: maxFee.toString(),
      };
    }

    /**
     * Ambil info transfer fee dari mint (parse TLV extension TransferFeeConfig, type 1)
     * @returns {null|{transferFeeConfigAuthority, withdrawWithheldAuthority, withheldAmount, transferFeeBasisPoints, maximumFee}}
     */
    async getTransferFeeInfo(mint) {
      try {
        const info = await this.connection.getAccountInfo(new PublicKey(mint), 'confirmed');
        if (!info || !info.owner.equals(SplToken.TOKEN_2022_PROGRAM_ID)) return null;
        const d = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        // Layout: [82 byte Mint][83 byte padding][1 byte account type][TLV: type u16, len u16, data]
        let off = 166;
        while (off + 4 <= d.length) {
          const type = dv.getUint16(off, true);
          const len = dv.getUint16(off + 2, true);
          const start = off + 4;
          if (type === 1 && len >= 108) {
            // authority(32) withdrawWithheldAuthority(32) withheldAmount(u64) older{epoch u64, maxFee u64, bps u16} newer{...}
            const pk = (o) => new PublicKey(d.slice(start + o, start + o + 32)).toString();
            const u64 = (o) => dv.getBigUint64(start + o, true).toString();
            return {
              transferFeeConfigAuthority: pk(0),
              withdrawWithheldAuthority: pk(32),
              withheldAmount: u64(64),
              transferFeeBasisPoints: dv.getUint16(start + 72 + 18 + 16, true),
              maximumFee: u64(72 + 18 + 8),
            };
          }
          off = start + len;
        }
        return null;
      } catch (_) {
        return null;
      }
    }
  }

  /* ==================== KLAIM FEE TERTAHAN (withdraw withheld) ==================== */
  const MAX_SOURCES_PER_TX = 20; // batas aman jumlah akun sumber per transaksi legacy

  /**
   * Pindai fee transfer yang tertahan untuk sebuah mint Token-2022.
   * @returns {{mint, decimals, feeConfig, mintWithheld: bigint, accounts: {address: PublicKey, withheld: bigint}[],
   *            accountsTotal: bigint, total: bigint, scanned: number, method: 'getProgramAccounts'|'getTokenLargestAccounts'}}
   */
  Token2022Manager.prototype.scanWithheldFees = async function (mint) {
    const connection = this.connection;
    const mintPk = new PublicKey(mint);
    const mintAcc = await connection.getAccountInfo(mintPk, 'confirmed');
    if (!mintAcc) throw new Error('Mint tidak ditemukan di jaringan ini');
    if (!mintAcc.owner.equals(SplToken.TOKEN_2022_PROGRAM_ID)) {
      throw new Error('Mint ini bukan Token-2022 (SPL Token klasik tidak punya transfer fee)');
    }
    const feeConfig = SplToken.getTransferFeeConfig(mintAcc.data);
    if (!feeConfig) throw new Error('Mint Token-2022 ini tidak memiliki extension transfer fee');
    const decimals = SplToken.unpackMint(mintPk, mintAcc).decimals;

    // Cari semua akun token mint ini yang menyimpan fee tertahan
    let raw = [];
    let method = 'getProgramAccounts';
    try {
      raw = await connection.getProgramAccounts(SplToken.TOKEN_2022_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
      });
    } catch (e) {
      // Beberapa RPC publik menonaktifkan getProgramAccounts → fallback: 20 akun terbesar
      method = 'getTokenLargestAccounts';
      const largest = await connection.getTokenLargestAccounts(mintPk, 'confirmed');
      const addrs = largest.value.map((v) => v.address);
      const infos = addrs.length ? await connection.getMultipleAccountsInfo(addrs, 'confirmed') : [];
      raw = infos.map((account, i) => ({ pubkey: addrs[i], account })).filter((x) => x.account);
    }
    const accounts = [];
    let accountsTotal = 0n;
    for (const { pubkey, account } of raw) {
      let parsed;
      try {
        parsed = SplToken.unpackAccount(pubkey, account);
      } catch (_) {
        continue; // bukan akun token (mis. akun mint lain) → lewati
      }
      const fee = SplToken.getTransferFeeAmount(parsed);
      if (fee && fee.withheldAmount > 0n) {
        accounts.push({ address: pubkey, withheld: fee.withheldAmount });
        accountsTotal += fee.withheldAmount;
      }
    }
    accounts.sort((a, b) => (a.withheld > b.withheld ? -1 : a.withheld < b.withheld ? 1 : 0));
    return {
      mint: mintPk.toBase58(),
      decimals,
      feeConfig,
      mintWithheld: feeConfig.withheldAmount,
      accounts,
      accountsTotal,
      total: accountsTotal + feeConfig.withheldAmount,
      scanned: raw.length,
      method,
    };
  };

  /**
   * Tarik semua fee tertahan ke ATA wallet (wallet harus = withdraw-withheld authority / FEE RECIPIENT).
   * Setiap transaksi memuat maks. 20 akun sumber; fee yang sudah berada di mint ikut ditarik.
   * @param {object} p {mint, payer: PublicKey, sendTransaction: (tx) => Promise<string>, scan?: hasil scanWithheldFees}
   * @returns {{signatures: string[], claimed: bigint, decimals, destination: string, accountsCount: number}}
   */
  Token2022Manager.prototype.claimWithheldFees = async function (p) {
    const connection = this.connection;
    const payer = new PublicKey(p.payer);
    const scan = p.scan || (await this.scanWithheldFees(p.mint));
    const mintPk = new PublicKey(scan.mint);
    const authority = scan.feeConfig.withdrawWithheldAuthority;
    if (!authority) throw new Error('Mint ini tidak memiliki withdraw-withheld authority (fee tidak bisa ditarik siapa pun)');
    if (!authority.equals(payer)) {
      throw new Error(`Wallet ini bukan FEE RECIPIENT / withdraw-withheld authority (authority: ${authority.toBase58()})`);
    }
    if (scan.total === 0n) throw new Error('Tidak ada fee tertahan yang bisa diklaim saat ini');

    const destination = await SplToken.getAssociatedTokenAddress(mintPk, payer, false, SplToken.TOKEN_2022_PROGRAM_ID);
    const destInfo = await connection.getAccountInfo(destination, 'confirmed');

    // Susun batch transaksi
    const batches = [];
    const sources = scan.accounts.map((a) => a.address);
    for (let i = 0; i < sources.length; i += MAX_SOURCES_PER_TX) batches.push(sources.slice(i, i + MAX_SOURCES_PER_TX));
    if (batches.length === 0) batches.push([]); // hanya fee di mint

    const signatures = [];
    for (let i = 0; i < batches.length; i++) {
      const tx = new Transaction();
      tx.feePayer = payer;
      if (i === 0 && !destInfo) {
        tx.add(
          SplToken.createAssociatedTokenAccountInstruction(payer, destination, payer, mintPk, SplToken.TOKEN_2022_PROGRAM_ID)
        );
      }
      if (batches[i].length) {
        tx.add(
          SplToken.createWithdrawWithheldTokensFromAccountsInstruction(
            mintPk, destination, payer, [], batches[i], SplToken.TOKEN_2022_PROGRAM_ID
          )
        );
      }
      if (i === 0 && scan.mintWithheld > 0n) {
        tx.add(SplToken.createWithdrawWithheldTokensFromMintInstruction(mintPk, destination, payer, [], SplToken.TOKEN_2022_PROGRAM_ID));
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      const signature = await p.sendTransaction(tx);
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      signatures.push(signature);
    }
    return {
      signatures,
      claimed: scan.total,
      decimals: scan.decimals,
      destination: destination.toBase58(),
      accountsCount: sources.length,
    };
  };

  /** Format jumlah unit terkecil → string desimal (tanpa floating point) */
  Token2022Manager.formatUnits = function (raw, decimals) {
    const s = BigInt(raw).toString().padStart(decimals + 1, '0');
    const int = s.slice(0, s.length - decimals);
    const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
    return frac ? `${int}.${frac}` : int;
  };

  root.Token2022Manager = Token2022Manager;
})(window);

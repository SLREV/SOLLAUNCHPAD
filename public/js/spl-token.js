/**
 * spl-token.js — Implementasi ringan (vanilla JS) dari fungsi @solana/spl-token
 * yang dipakai dashboard. Tidak butuh Buffer global; hanya Uint8Array + web3.js IIFE.
 *
 * Fungsi yang disediakan identik secara byte dengan @solana/spl-token v0.3.x
 * (sudah diverifikasi dengan test di scripts/verify-spl-token.js):
 *   - createInitializeMintInstruction
 *   - createAssociatedTokenAccountInstruction
 *   - createMintToInstruction
 *   - createSetAuthorityInstruction  (dipakai untuk revoke mint/freeze authority)
 *   - createInitializeTransferFeeConfigInstruction (Token-2022)
 *   - createWithdrawWithheldTokensFromAccountsInstruction / ...FromMintInstruction (klaim fee Token-2022)
 *   - createHarvestWithheldTokensToMintInstruction (Token-2022, permissionless)
 *   - getAssociatedTokenAddress / getAssociatedTokenAddressSync
 *   - getMint (parse akun mint on-chain), unpackAccount + getTransferFeeAmount (parse akun token + fee tertahan)
 *   - getMintLen (ukuran akun mint + extension)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@solana/web3.js'));
  } else {
    root.SplToken = factory(root.solanaWeb3);
  }
})(typeof self !== 'undefined' ? self : this, function (web3) {
  'use strict';

  const { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = web3;

  /* ==================== CONSTANTS ==================== */
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const MINT_SIZE = 82;
  const ACCOUNT_SIZE = 165;

  const TokenInstruction = {
    InitializeMint: 0,
    MintTo: 7,
    SetAuthority: 6,
    TransferFeeExtension: 26,
  };

  // Sub-instruksi TransferFeeExtension (Token-2022)
  const TransferFeeInstruction = {
    InitializeTransferFeeConfig: 0,
    TransferCheckedWithFee: 1,
    WithdrawWithheldTokensFromMint: 2,
    WithdrawWithheldTokensFromAccounts: 3,
    HarvestWithheldTokensToMint: 4,
    SetTransferFee: 5,
  };

  const AuthorityType = {
    MintTokens: 0,
    FreezeAccount: 1,
    AccountOwner: 2,
    CloseAccount: 3,
    TransferFeeConfig: 4,
    WithheldWithdraw: 5,
    CloseMint: 6,
    InterestRate: 7,
    PermanentDelegate: 8,
    ConfidentialTransferMint: 9,
    TransferHookProgramId: 10,
    ConfidentialTransferFeeConfig: 11,
    MetadataPointer: 12,
  };

  const ExtensionType = {
    Uninitialized: 0,
    TransferFeeConfig: 1,
    TransferFeeAmount: 2,
    MintCloseAuthority: 3,
  };

  // Ukuran data extension (tanpa header 4 byte)
  const EXTENSION_SIZES = {
    [ExtensionType.TransferFeeConfig]: 108,
    [ExtensionType.TransferFeeAmount]: 8,
    [ExtensionType.MintCloseAuthority]: 32,
  };

  /* ==================== BYTE HELPERS ==================== */
  function writeU64LE(view, offset, value) {
    const v = BigInt(value);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('u64 out of range');
    view.setBigUint64(offset, v, true);
  }

  function readU64LE(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getBigUint64(offset, true);
  }

  function readU32LE(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(offset, true);
  }

  function pubkeyBytes(pk) {
    return new PublicKey(pk).toBytes();
  }

  function toPublicKey(x) {
    return x instanceof PublicKey ? x : new PublicKey(x);
  }

  function addSigners(keys, ownerOrAuthority, multiSigners) {
    if (multiSigners && multiSigners.length) {
      keys.push({ pubkey: toPublicKey(ownerOrAuthority), isSigner: false, isWritable: false });
      for (const signer of multiSigners) {
        keys.push({ pubkey: signer.publicKey ? signer.publicKey : toPublicKey(signer), isSigner: true, isWritable: false });
      }
    } else {
      keys.push({ pubkey: toPublicKey(ownerOrAuthority), isSigner: true, isWritable: false });
    }
    return keys;
  }

  /* ==================== ASSOCIATED TOKEN ADDRESS ==================== */
  function getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, programId, associatedTokenProgramId) {
    mint = toPublicKey(mint);
    owner = toPublicKey(owner);
    programId = programId ? toPublicKey(programId) : TOKEN_PROGRAM_ID;
    associatedTokenProgramId = associatedTokenProgramId ? toPublicKey(associatedTokenProgramId) : ASSOCIATED_TOKEN_PROGRAM_ID;
    if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBytes())) {
      throw new Error('TokenOwnerOffCurveError');
    }
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBytes(), programId.toBytes(), mint.toBytes()],
      associatedTokenProgramId
    );
    return address;
  }

  async function getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve, programId, associatedTokenProgramId) {
    return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, programId, associatedTokenProgramId);
  }

  /* ==================== INSTRUCTIONS ==================== */

  /** InitializeMint (index 0): [u8 ix][u8 decimals][32 mintAuthority][u8 freezeOpt][32 freezeAuthority] */
  function createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_PROGRAM_ID;
    const data = new Uint8Array(67);
    data[0] = TokenInstruction.InitializeMint;
    data[1] = decimals;
    data.set(pubkeyBytes(mintAuthority), 2);
    if (freezeAuthority) {
      data[34] = 1;
      data.set(pubkeyBytes(freezeAuthority), 35);
    } else {
      data[34] = 0; // freezeAuthority dibiarkan nol (sama dengan spl-token)
    }
    const keys = [
      { pubkey: toPublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId, data });
  }

  /** Create Associated Token Account: data kosong */
  function createAssociatedTokenAccountInstruction(payer, associatedToken, owner, mint, programId, associatedTokenProgramId) {
    programId = programId ? toPublicKey(programId) : TOKEN_PROGRAM_ID;
    associatedTokenProgramId = associatedTokenProgramId ? toPublicKey(associatedTokenProgramId) : ASSOCIATED_TOKEN_PROGRAM_ID;
    const keys = [
      { pubkey: toPublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: toPublicKey(associatedToken), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: toPublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: associatedTokenProgramId, data: new Uint8Array(0) });
  }

  /** MintTo (index 7): [u8 ix][u64 amount] */
  function createMintToInstruction(mint, destination, authority, amount, multiSigners, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_PROGRAM_ID;
    const data = new Uint8Array(9);
    const view = new DataView(data.buffer);
    data[0] = TokenInstruction.MintTo;
    writeU64LE(view, 1, amount);
    const keys = addSigners(
      [
        { pubkey: toPublicKey(mint), isSigner: false, isWritable: true },
        { pubkey: toPublicKey(destination), isSigner: false, isWritable: true },
      ],
      authority,
      multiSigners || []
    );
    return new TransactionInstruction({ keys, programId, data });
  }

  /** SetAuthority (index 6): [u8 ix][u8 authorityType][u8 newAuthOpt][32 newAuthority] */
  function createSetAuthorityInstruction(account, currentAuthority, authorityType, newAuthority, multiSigners, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_PROGRAM_ID;
    const data = new Uint8Array(35);
    data[0] = TokenInstruction.SetAuthority;
    data[1] = authorityType;
    if (newAuthority) {
      data[2] = 1;
      data.set(pubkeyBytes(newAuthority), 3);
    } else {
      data[2] = 0;
    }
    const keys = addSigners(
      [{ pubkey: toPublicKey(account), isSigner: false, isWritable: true }],
      currentAuthority,
      multiSigners || []
    );
    return new TransactionInstruction({ keys, programId, data });
  }

  /**
   * Token-2022 InitializeTransferFeeConfig (ix 26, sub-ix 0) — total 78 byte:
   * [u8 26][u8 0][COption<pubkey> configAuthority (33)][COption<pubkey> withdrawAuthority (33)][u16 bps][u64 maxFee]
   * COption = 1 byte flag + 32 byte pubkey (nol jika None), persis seperti @solana/spl-token.
   */
  function createInitializeTransferFeeConfigInstruction(mint, transferFeeConfigAuthority, withdrawWithheldAuthority, transferFeeBasisPoints, maximumFee, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_2022_PROGRAM_ID;
    const data = new Uint8Array(78);
    const view = new DataView(data.buffer);
    data[0] = TokenInstruction.TransferFeeExtension;
    data[1] = 0;
    let off = 2;
    for (const auth of [transferFeeConfigAuthority, withdrawWithheldAuthority]) {
      if (auth) {
        data[off] = 1;
        data.set(pubkeyBytes(auth), off + 1);
      }
      off += 33;
    }
    view.setUint16(off, transferFeeBasisPoints, true);
    writeU64LE(view, off + 2, maximumFee);

    const keys = [{ pubkey: toPublicKey(mint), isSigner: false, isWritable: true }];
    return new TransactionInstruction({ keys, programId, data });
  }

  /**
   * Token-2022 WithdrawWithheldTokensFromMint (ix 26, sub-ix 2): tarik fee yang sudah di-harvest ke akun mint.
   * keys: mint (w), destination (w), authority (signer / multisig + signers)
   */
  function createWithdrawWithheldTokensFromMintInstruction(mint, destination, authority, signers, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_2022_PROGRAM_ID;
    const data = new Uint8Array([TokenInstruction.TransferFeeExtension, TransferFeeInstruction.WithdrawWithheldTokensFromMint]);
    const keys = addSigners(
      [
        { pubkey: toPublicKey(mint), isSigner: false, isWritable: true },
        { pubkey: toPublicKey(destination), isSigner: false, isWritable: true },
      ],
      authority,
      signers || []
    );
    return new TransactionInstruction({ keys, programId, data });
  }

  /**
   * Token-2022 WithdrawWithheldTokensFromAccounts (ix 26, sub-ix 3): tarik fee tertahan langsung dari akun token.
   * data: [26][3][u8 jumlah akun sumber]; keys: mint (w), destination (w), authority (signer), ...sources (w)
   */
  function createWithdrawWithheldTokensFromAccountsInstruction(mint, destination, authority, signers, sources, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_2022_PROGRAM_ID;
    const data = new Uint8Array([
      TokenInstruction.TransferFeeExtension,
      TransferFeeInstruction.WithdrawWithheldTokensFromAccounts,
      sources.length,
    ]);
    const keys = addSigners(
      [
        { pubkey: toPublicKey(mint), isSigner: false, isWritable: true },
        { pubkey: toPublicKey(destination), isSigner: false, isWritable: true },
      ],
      authority,
      signers || []
    );
    for (const source of sources) keys.push({ pubkey: toPublicKey(source), isSigner: false, isWritable: true });
    return new TransactionInstruction({ keys, programId, data });
  }

  /**
   * Token-2022 HarvestWithheldTokensToMint (ix 26, sub-ix 4): pindahkan fee tertahan dari akun token ke mint
   * (permissionless — siapa pun boleh memanggil). keys: mint (w), ...sources (w)
   */
  function createHarvestWithheldTokensToMintInstruction(mint, sources, programId) {
    programId = programId ? toPublicKey(programId) : TOKEN_2022_PROGRAM_ID;
    const data = new Uint8Array([TokenInstruction.TransferFeeExtension, TransferFeeInstruction.HarvestWithheldTokensToMint]);
    const keys = [{ pubkey: toPublicKey(mint), isSigner: false, isWritable: true }].concat(
      sources.map((source) => ({ pubkey: toPublicKey(source), isSigner: false, isWritable: true }))
    );
    return new TransactionInstruction({ keys, programId, data });
  }

  /* ==================== ACCOUNT SIZE ==================== */
  function getMintLen(extensionTypes) {
    if (!extensionTypes || extensionTypes.length === 0) return MINT_SIZE;
    // Layout akun dengan extension: 165 (padding ke ACCOUNT_SIZE) + 1 (account type) + Σ(2 type + 2 len + data)
    let len = ACCOUNT_SIZE + 1;
    for (const t of extensionTypes) {
      if (EXTENSION_SIZES[t] === undefined) throw new Error('Unknown extension type: ' + t);
      len += 4 + EXTENSION_SIZES[t];
    }
    return len;
  }

  /* ==================== MINT PARSER ==================== */
  function unpackMint(address, info) {
    if (!info) throw new Error('TokenAccountNotFoundError');
    const owner = info.owner;
    if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error('TokenInvalidAccountOwnerError');
    }
    const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
    if (data.length < MINT_SIZE) throw new Error('TokenInvalidAccountSizeError');
    const mintAuthorityOption = readU32LE(data, 0);
    const freezeAuthorityOption = readU32LE(data, 46);
    return {
      address: toPublicKey(address),
      mintAuthority: mintAuthorityOption ? new PublicKey(data.slice(4, 36)) : null,
      supply: readU64LE(data, 36),
      decimals: data[44],
      isInitialized: data[45] === 1,
      freezeAuthority: freezeAuthorityOption ? new PublicKey(data.slice(50, 82)) : null,
      programId: owner,
    };
  }

  async function getMint(connection, address, commitment) {
    const info = await connection.getAccountInfo(toPublicKey(address), commitment || 'confirmed');
    return unpackMint(address, info);
  }

  /* ==================== TOKEN ACCOUNT PARSER ==================== */
  const AccountState = { Uninitialized: 0, Initialized: 1, Frozen: 2 };

  /** Setara @solana/spl-token unpackAccount (SPL Token & Token-2022, termasuk tlvData extension) */
  function unpackAccount(address, info) {
    if (!info) throw new Error('TokenAccountNotFoundError');
    const owner = info.owner;
    if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error('TokenInvalidAccountOwnerError');
    }
    const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
    if (data.length < ACCOUNT_SIZE) throw new Error('TokenInvalidAccountSizeError');
    const delegateOption = readU32LE(data, 72);
    const isNativeOption = readU32LE(data, 109);
    const closeAuthorityOption = readU32LE(data, 129);
    const state = data[108];
    let tlvData = new Uint8Array(0);
    if (data.length > ACCOUNT_SIZE) {
      if (data.length === MINT_SIZE + 1 /* 83: tidak mungkin untuk account */ || data[ACCOUNT_SIZE] !== 2) {
        throw new Error('TokenInvalidAccountError');
      }
      tlvData = data.slice(ACCOUNT_SIZE + 1);
    }
    return {
      address: toPublicKey(address),
      mint: new PublicKey(data.slice(0, 32)),
      owner: new PublicKey(data.slice(32, 64)),
      amount: readU64LE(data, 64),
      delegate: delegateOption ? new PublicKey(data.slice(76, 108)) : null,
      delegatedAmount: readU64LE(data, 121),
      isInitialized: state !== AccountState.Uninitialized,
      isFrozen: state === AccountState.Frozen,
      isNative: !!isNativeOption,
      rentExemptReserve: isNativeOption ? readU64LE(data, 113) : null,
      closeAuthority: closeAuthorityOption ? new PublicKey(data.slice(133, 165)) : null,
      programId: owner,
      tlvData,
    };
  }

  /** Cari data extension bertipe tertentu di tlvData (null jika tidak ada) */
  function getExtensionData(extensionType, tlvData) {
    let off = 0;
    while (off + 4 <= tlvData.length) {
      const type = tlvData[off] | (tlvData[off + 1] << 8);
      const len = tlvData[off + 2] | (tlvData[off + 3] << 8);
      const start = off + 4;
      if (type === extensionType) return tlvData.slice(start, start + len);
      off = start + len;
    }
    return null;
  }

  /** Fee tertahan di sebuah akun token Token-2022 (extension TransferFeeAmount) → {withheldAmount: bigint} | null */
  function getTransferFeeAmount(account) {
    const ext = getExtensionData(ExtensionType.TransferFeeAmount, account.tlvData || new Uint8Array(0));
    if (!ext || ext.length < 8) return null;
    return { withheldAmount: readU64LE(ext, 0) };
  }

  /** Konfigurasi transfer fee mint Token-2022 (extension TransferFeeConfig) atau null */
  function getTransferFeeConfig(mintData) {
    const data = mintData instanceof Uint8Array ? mintData : new Uint8Array(mintData);
    if (data.length <= ACCOUNT_SIZE + 1) return null;
    const ext = getExtensionData(ExtensionType.TransferFeeConfig, data.slice(ACCOUNT_SIZE + 1));
    if (!ext || ext.length < 108) return null;
    const readFee = (o) => ({
      epoch: readU64LE(ext, o),
      maximumFee: readU64LE(ext, o + 8),
      transferFeeBasisPoints: ext[o + 16] | (ext[o + 17] << 8),
    });
    const zero = new Uint8Array(32);
    const optPk = (o) => (ext.slice(o, o + 32).every((b, i) => b === zero[i]) ? null : new PublicKey(ext.slice(o, o + 32)));
    return {
      transferFeeConfigAuthority: optPk(0),
      withdrawWithheldAuthority: optPk(32),
      withheldAmount: readU64LE(ext, 64),
      olderTransferFee: readFee(72),
      newerTransferFee: readFee(90),
    };
  }

  return {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MINT_SIZE,
    ACCOUNT_SIZE,
    TokenInstruction,
    AuthorityType,
    ExtensionType,
    getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    createInitializeTransferFeeConfigInstruction,
    createWithdrawWithheldTokensFromMintInstruction,
    createWithdrawWithheldTokensFromAccountsInstruction,
    createHarvestWithheldTokensToMintInstruction,
    TransferFeeInstruction,
    AccountState,
    getMintLen,
    unpackMint,
    getMint,
    unpackAccount,
    getExtensionData,
    getTransferFeeAmount,
    getTransferFeeConfig,
  };
});

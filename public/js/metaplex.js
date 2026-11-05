/**
 * metaplex.js — Metaplex Token Metadata (program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s)
 *
 * Implementasi ringan tanpa dependensi (encoding borsh manual) untuk:
 *   - findMetadataPda(mint)                     : PDA akun metadata sebuah mint
 *   - createMetadataAccountV3Instruction(...)   : buat metadata on-chain (nama, symbol, URI) saat token dibuat (SPL Token)
 *   - createV1Instruction(...)                  : idem untuk mint Token-2022 (instruksi Create V1, token standard Fungible)
 *   - updateMetadataAccountV2Instruction(...)   : ubah metadata / cabut update authority (isMutable = false)
 *   - getMetadata(connection, mint)             : baca & parse metadata on-chain (nama, symbol, URI, authority)
 *
 * Dipakai oleh: Create Token, Clone Token (AMBIL DATA), Token-2022, Revoke Metadata Update Authority.
 */
(function (root) {
  'use strict';

  const web3 = root.solanaWeb3;
  const { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY } = web3;

  const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  const MAX_NAME_LENGTH = 32;
  const MAX_SYMBOL_LENGTH = 10;
  const MAX_URI_LENGTH = 200;

  const utf8Encoder = new TextEncoder();
  const utf8Decoder = new TextDecoder();

  /* ---------- helper encoding ---------- */
  function u16le(n) {
    return Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
  }
  function u32le(n) {
    return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  }
  function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  /** Borsh string: u32 panjang byte + utf8 */
  function borshString(s) {
    const bytes = utf8Encoder.encode(s || '');
    return concat([u32le(bytes.length), bytes]);
  }
  function byteLength(s) {
    return utf8Encoder.encode(s || '').length;
  }

  /** Validasi batas Metaplex (dihitung dalam byte UTF-8) */
  function validateData(data) {
    if (byteLength(data.name) > MAX_NAME_LENGTH) throw new Error(`Nama token maksimal ${MAX_NAME_LENGTH} byte (Metaplex)`);
    if (byteLength(data.symbol) > MAX_SYMBOL_LENGTH) throw new Error(`Symbol maksimal ${MAX_SYMBOL_LENGTH} byte (Metaplex)`);
    if (byteLength(data.uri) > MAX_URI_LENGTH) throw new Error(`Metadata URI maksimal ${MAX_URI_LENGTH} byte (Metaplex)`);
  }

  /* ---------- PDA ---------- */
  function findMetadataPda(mint) {
    const mintPk = new PublicKey(mint);
    return PublicKey.findProgramAddressSync(
      [utf8Encoder.encode('metadata'), METADATA_PROGRAM_ID.toBytes(), mintPk.toBytes()],
      METADATA_PROGRAM_ID
    )[0];
  }

  /* ---------- instruksi ---------- */
  /**
   * CreateMetadataAccountV3 (discriminator 33)
   * @param {object} p { mint, mintAuthority, payer, updateAuthority, name, symbol, uri, sellerFeeBasisPoints?, isMutable? }
   */
  function createMetadataAccountV3Instruction(p) {
    const data = { name: p.name || '', symbol: p.symbol || '', uri: p.uri || '' };
    validateData(data);
    const metadata = p.metadata ? new PublicKey(p.metadata) : findMetadataPda(p.mint);
    const isMutable = p.isMutable !== false;
    const buf = concat([
      Uint8Array.of(33), // instruction: CreateMetadataAccountV3
      borshString(data.name),
      borshString(data.symbol),
      borshString(data.uri),
      u16le(p.sellerFeeBasisPoints || 0),
      Uint8Array.of(0), // creators: None
      Uint8Array.of(0), // collection: None
      Uint8Array.of(0), // uses: None
      Uint8Array.of(isMutable ? 1 : 0), // isMutable
      Uint8Array.of(0), // collectionDetails: None
    ]);
    return new TransactionInstruction({
      programId: METADATA_PROGRAM_ID,
      keys: [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(p.mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(p.mintAuthority), isSigner: true, isWritable: false },
        { pubkey: new PublicKey(p.payer), isSigner: true, isWritable: true },
        { pubkey: new PublicKey(p.updateAuthority), isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: buf,
    });
  }

  /**
   * CreateV1 (discriminator 42) — instruksi Metaplex generasi baru, mendukung mint Token-2022
   * (CreateMetadataAccountV3 menolak mint Token-2022 dengan error InstructionNotSupported 0x99).
   * Token standard: Fungible (2).
   * @param {object} p { mint, authority (mint authority), payer, updateAuthority, name, symbol, uri, tokenProgram, sellerFeeBasisPoints?, isMutable? }
   */
  function createV1Instruction(p) {
    const data = { name: p.name || '', symbol: p.symbol || '', uri: p.uri || '' };
    validateData(data);
    const metadata = p.metadata ? new PublicKey(p.metadata) : findMetadataPda(p.mint);
    const isMutable = p.isMutable !== false;
    const buf = concat([
      Uint8Array.of(42), // instruction: Create
      Uint8Array.of(0), // CreateArgs::V1
      borshString(data.name),
      borshString(data.symbol),
      borshString(data.uri),
      u16le(p.sellerFeeBasisPoints || 0),
      Uint8Array.of(0), // creators: None
      Uint8Array.of(0), // primarySaleHappened: false
      Uint8Array.of(isMutable ? 1 : 0), // isMutable
      Uint8Array.of(2), // tokenStandard: Fungible
      Uint8Array.of(0), // collection: None
      Uint8Array.of(0), // uses: None
      Uint8Array.of(0), // collectionDetails: None
      Uint8Array.of(0), // ruleSet: None
      Uint8Array.of(0), // decimals: None (mint sudah ada)
      Uint8Array.of(0), // printSupply: None
    ]);
    const tokenProgram = p.tokenProgram ? new PublicKey(p.tokenProgram) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    return new TransactionInstruction({
      programId: METADATA_PROGRAM_ID,
      keys: [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false }, // masterEdition: None (placeholder = program id)
        { pubkey: new PublicKey(p.mint), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(p.authority), isSigner: true, isWritable: false },
        { pubkey: new PublicKey(p.payer), isSigner: true, isWritable: true },
        { pubkey: new PublicKey(p.updateAuthority), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: buf,
    });
  }

  /**
   * UpdateMetadataAccountV2 (discriminator 15)
   * @param {object} p { mint | metadata, updateAuthority, newUpdateAuthority?, data?: {name,symbol,uri,sellerFeeBasisPoints}, primarySaleHappened?, isMutable? }
   */
  function updateMetadataAccountV2Instruction(p) {
    const metadata = p.metadata ? new PublicKey(p.metadata) : findMetadataPda(p.mint);
    const parts = [Uint8Array.of(15)];
    // data: Option<DataV2>
    if (p.data) {
      validateData(p.data);
      parts.push(
        Uint8Array.of(1),
        borshString(p.data.name),
        borshString(p.data.symbol),
        borshString(p.data.uri),
        u16le(p.data.sellerFeeBasisPoints || 0),
        Uint8Array.of(0), // creators None
        Uint8Array.of(0), // collection None
        Uint8Array.of(0) // uses None
      );
    } else {
      parts.push(Uint8Array.of(0));
    }
    // updateAuthority: Option<Pubkey>
    if (p.newUpdateAuthority) parts.push(Uint8Array.of(1), new PublicKey(p.newUpdateAuthority).toBytes());
    else parts.push(Uint8Array.of(0));
    // primarySaleHappened: Option<bool>
    if (p.primarySaleHappened === true || p.primarySaleHappened === false) parts.push(Uint8Array.of(1, p.primarySaleHappened ? 1 : 0));
    else parts.push(Uint8Array.of(0));
    // isMutable: Option<bool>
    if (p.isMutable === true || p.isMutable === false) parts.push(Uint8Array.of(1, p.isMutable ? 1 : 0));
    else parts.push(Uint8Array.of(0));

    return new TransactionInstruction({
      programId: METADATA_PROGRAM_ID,
      keys: [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(p.updateAuthority), isSigner: true, isWritable: false },
      ],
      data: concat(parts),
    });
  }

  /** Instruksi "revoke update authority": metadata dijadikan permanen (isMutable = false) */
  function createRevokeUpdateAuthorityInstruction(mint, updateAuthority) {
    return updateMetadataAccountV2Instruction({ mint, updateAuthority, isMutable: false });
  }

  /* ---------- parsing akun metadata ---------- */
  function parseMetadata(bytes) {
    const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let off = 0;
    const readU8 = () => d[off++];
    const readU16 = () => {
      const v = dv.getUint16(off, true);
      off += 2;
      return v;
    };
    const readU32 = () => {
      const v = dv.getUint32(off, true);
      off += 4;
      return v;
    };
    const readPubkey = () => {
      const pk = new PublicKey(d.slice(off, off + 32));
      off += 32;
      return pk;
    };
    const readString = () => {
      const len = readU32();
      const s = utf8Decoder.decode(d.slice(off, off + len));
      off += len;
      return s.replace(/\0+$/g, ''); // Metaplex mem-padding string dengan \0
    };

    const key = readU8();
    const updateAuthority = readPubkey();
    const mint = readPubkey();
    const name = readString();
    const symbol = readString();
    const uri = readString();
    const sellerFeeBasisPoints = readU16();
    let creators = null;
    if (readU8() === 1) {
      const n = readU32();
      creators = [];
      for (let i = 0; i < n; i++) {
        creators.push({ address: readPubkey(), verified: readU8() === 1, share: readU8() });
      }
    }
    let primarySaleHappened;
    let isMutable;
    try {
      primarySaleHappened = readU8() === 1;
      isMutable = readU8() === 1;
    } catch (_) {
      /* data lama/terpotong: biarkan undefined */
    }

    return {
      key,
      updateAuthority: updateAuthority.toBase58(),
      mint: mint.toBase58(),
      name,
      symbol,
      uri,
      sellerFeeBasisPoints,
      creators,
      primarySaleHappened,
      isMutable,
    };
  }

  /** Ambil metadata on-chain untuk mint; null jika tidak ada akun metadata */
  async function getMetadata(connection, mint) {
    const pda = findMetadataPda(mint);
    const info = await connection.getAccountInfo(pda, 'confirmed');
    if (!info || !info.data || info.data.length < 65) return null;
    const parsed = parseMetadata(info.data);
    parsed.address = pda.toBase58();
    return parsed;
  }

  root.Metaplex = {
    METADATA_PROGRAM_ID,
    MAX_NAME_LENGTH,
    MAX_SYMBOL_LENGTH,
    MAX_URI_LENGTH,
    findMetadataPda,
    createMetadataAccountV3Instruction,
    createV1Instruction,
    updateMetadataAccountV2Instruction,
    createRevokeUpdateAuthorityInstruction,
    parseMetadata,
    getMetadata,
    validateData,
  };
})(window);

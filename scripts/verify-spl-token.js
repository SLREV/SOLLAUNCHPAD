/**
 * Verifikasi: output public/js/spl-token.js harus identik byte-per-byte
 * dengan @solana/spl-token resmi. Jalankan dari folder yang punya
 * node_modules berisi @solana/web3.js dan @solana/spl-token:
 *
 *   node scripts/verify-spl-token.js
 */
const path = require('path');
const assert = require('assert');
const { Keypair, PublicKey } = require('@solana/web3.js');
const ref = require('@solana/spl-token');
const mine = require(path.join(__dirname, '..', 'public', 'js', 'spl-token.js'));

function ixEqual(a, b, label) {
  assert.strictEqual(a.programId.toBase58(), b.programId.toBase58(), label + ': programId');
  assert.strictEqual(a.keys.length, b.keys.length, label + ': keys length');
  a.keys.forEach((k, i) => {
    assert.strictEqual(k.pubkey.toBase58(), b.keys[i].pubkey.toBase58(), `${label}: key[${i}] pubkey`);
    assert.strictEqual(k.isSigner, b.keys[i].isSigner, `${label}: key[${i}] isSigner`);
    assert.strictEqual(k.isWritable, b.keys[i].isWritable, `${label}: key[${i}] isWritable`);
  });
  assert.deepStrictEqual(Array.from(a.data), Array.from(b.data), label + ': data bytes');
  console.log('  ✔', label, `(${a.data.length} bytes, ${a.keys.length} keys)`);
}

const payer = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

console.log('Constants');
assert.strictEqual(mine.TOKEN_PROGRAM_ID.toBase58(), ref.TOKEN_PROGRAM_ID.toBase58());
assert.strictEqual(mine.TOKEN_2022_PROGRAM_ID.toBase58(), ref.TOKEN_2022_PROGRAM_ID.toBase58());
assert.strictEqual(mine.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), ref.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
assert.strictEqual(mine.MINT_SIZE, ref.MINT_SIZE);
assert.strictEqual(mine.AuthorityType.MintTokens, ref.AuthorityType.MintTokens);
assert.strictEqual(mine.AuthorityType.FreezeAccount, ref.AuthorityType.FreezeAccount);
console.log('  ✔ program ids, MINT_SIZE, AuthorityType');

console.log('getMintLen');
assert.strictEqual(mine.getMintLen([]), ref.getMintLen([]));
assert.strictEqual(mine.getMintLen([mine.ExtensionType.TransferFeeConfig]), ref.getMintLen([ref.ExtensionType.TransferFeeConfig]));
console.log('  ✔ base =', mine.getMintLen([]), '| TransferFeeConfig =', mine.getMintLen([mine.ExtensionType.TransferFeeConfig]));

console.log('getAssociatedTokenAddress');
for (const pid of [undefined, ref.TOKEN_2022_PROGRAM_ID]) {
  const a = mine.getAssociatedTokenAddressSync(mint, payer, false, pid);
  const b = ref.getAssociatedTokenAddressSync(mint, payer, false, pid);
  assert.strictEqual(a.toBase58(), b.toBase58());
}
console.log('  ✔ SPL & Token-2022 ATA');

console.log('Instructions');
ixEqual(
  mine.createInitializeMintInstruction(mint, 9, payer, null),
  ref.createInitializeMintInstruction(mint, 9, payer, null),
  'InitializeMint (no freeze)'
);
ixEqual(
  mine.createInitializeMintInstruction(mint, 6, payer, other, mine.TOKEN_2022_PROGRAM_ID),
  ref.createInitializeMintInstruction(mint, 6, payer, other, ref.TOKEN_2022_PROGRAM_ID),
  'InitializeMint (freeze, Token-2022)'
);
const ata = mine.getAssociatedTokenAddressSync(mint, payer);
ixEqual(
  mine.createAssociatedTokenAccountInstruction(payer, ata, payer, mint),
  ref.createAssociatedTokenAccountInstruction(payer, ata, payer, mint),
  'CreateAssociatedTokenAccount'
);
ixEqual(
  mine.createAssociatedTokenAccountInstruction(payer, ata, payer, mint, mine.TOKEN_2022_PROGRAM_ID),
  ref.createAssociatedTokenAccountInstruction(payer, ata, payer, mint, ref.TOKEN_2022_PROGRAM_ID),
  'CreateAssociatedTokenAccount (Token-2022)'
);
ixEqual(
  mine.createMintToInstruction(mint, ata, payer, 1000 * 1e9),
  ref.createMintToInstruction(mint, ata, payer, 1000 * 1e9),
  'MintTo'
);
ixEqual(
  mine.createMintToInstruction(mint, ata, payer, 123456789n, [], mine.TOKEN_2022_PROGRAM_ID),
  ref.createMintToInstruction(mint, ata, payer, 123456789n, [], ref.TOKEN_2022_PROGRAM_ID),
  'MintTo (bigint, Token-2022)'
);
ixEqual(
  mine.createSetAuthorityInstruction(mint, payer, mine.AuthorityType.MintTokens, null),
  ref.createSetAuthorityInstruction(mint, payer, ref.AuthorityType.MintTokens, null),
  'SetAuthority MintTokens → null (revoke mint)'
);
ixEqual(
  mine.createSetAuthorityInstruction(mint, payer, mine.AuthorityType.FreezeAccount, null),
  ref.createSetAuthorityInstruction(mint, payer, ref.AuthorityType.FreezeAccount, null),
  'SetAuthority FreezeAccount → null (revoke freeze)'
);
ixEqual(
  mine.createSetAuthorityInstruction(mint, payer, mine.AuthorityType.MintTokens, other),
  ref.createSetAuthorityInstruction(mint, payer, ref.AuthorityType.MintTokens, other),
  'SetAuthority → new authority'
);
ixEqual(
  mine.createInitializeTransferFeeConfigInstruction(mint, payer, payer, 100, 1000000n),
  ref.createInitializeTransferFeeConfigInstruction(mint, payer, payer, 100, 1000000n, ref.TOKEN_2022_PROGRAM_ID),
  'InitializeTransferFeeConfig'
);
ixEqual(
  mine.createInitializeTransferFeeConfigInstruction(mint, null, payer, 250, 0n),
  ref.createInitializeTransferFeeConfigInstruction(mint, null, payer, 250, 0n, ref.TOKEN_2022_PROGRAM_ID),
  'InitializeTransferFeeConfig (null config authority)'
);

console.log('Instructions Token-2022 transfer fee (klaim)');
{
  const dest = Keypair.generate().publicKey;
  const srcs = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  ixEqual(
    mine.createWithdrawWithheldTokensFromAccountsInstruction(mint, dest, payer, [], srcs, mine.TOKEN_2022_PROGRAM_ID),
    ref.createWithdrawWithheldTokensFromAccountsInstruction(mint, dest, payer, [], srcs, ref.TOKEN_2022_PROGRAM_ID),
    'WithdrawWithheldTokensFromAccounts (3 sumber)'
  );
  ixEqual(
    mine.createWithdrawWithheldTokensFromMintInstruction(mint, dest, payer, [], mine.TOKEN_2022_PROGRAM_ID),
    ref.createWithdrawWithheldTokensFromMintInstruction(mint, dest, payer, [], ref.TOKEN_2022_PROGRAM_ID),
    'WithdrawWithheldTokensFromMint'
  );
  ixEqual(
    mine.createHarvestWithheldTokensToMintInstruction(mint, srcs, mine.TOKEN_2022_PROGRAM_ID),
    ref.createHarvestWithheldTokensToMintInstruction(mint, srcs, ref.TOKEN_2022_PROGRAM_ID),
    'HarvestWithheldTokensToMint'
  );
}

console.log('unpackAccount + getTransferFeeAmount');
{
  // Bangun data akun Token-2022 (165 base + 1 tipe + TLV TransferFeeAmount) lalu bandingkan parser
  const data = Buffer.alloc(165 + 1 + 4 + 8);
  mint.toBuffer().copy(data, 0);
  payer.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(123456789n, 64);
  data.writeUInt8(1, 108); // state initialized
  data.writeUInt8(2, 165); // AccountType.Account
  data.writeUInt16LE(2, 166); // ExtensionType.TransferFeeAmount
  data.writeUInt16LE(8, 168);
  data.writeBigUInt64LE(987654n, 170);
  const info = { owner: ref.TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false };
  const a = mine.unpackAccount(other, info);
  const b = ref.unpackAccount(other, info, ref.TOKEN_2022_PROGRAM_ID);
  assert.strictEqual(a.mint.toBase58(), b.mint.toBase58());
  assert.strictEqual(a.owner.toBase58(), b.owner.toBase58());
  assert.strictEqual(a.amount, b.amount);
  assert.strictEqual(a.isInitialized, b.isInitialized);
  assert.strictEqual(a.isFrozen, b.isFrozen);
  assert.deepStrictEqual(Array.from(a.tlvData), Array.from(b.tlvData));
  assert.strictEqual(mine.getTransferFeeAmount(a).withheldAmount, ref.getTransferFeeAmount(b).withheldAmount);
  assert.strictEqual(mine.getTransferFeeAmount(a).withheldAmount, 987654n);
  console.log('  ✔ field akun & withheldAmount identik (987654)');
}

console.log('unpackMint');
{
  // bangun data mint palsu dengan layout resmi lalu parse
  const data = Buffer.alloc(82);
  ref.MintLayout.encode(
    { mintAuthorityOption: 1, mintAuthority: payer, supply: 5000000000n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data
  );
  const parsed = mine.unpackMint(mint, { owner: ref.TOKEN_PROGRAM_ID, data, lamports: 1, executable: false });
  const refParsed = ref.unpackMint(mint, { owner: ref.TOKEN_PROGRAM_ID, data, lamports: 1, executable: false });
  assert.strictEqual(parsed.decimals, refParsed.decimals);
  assert.strictEqual(parsed.supply, refParsed.supply);
  assert.strictEqual(parsed.mintAuthority.toBase58(), refParsed.mintAuthority.toBase58());
  assert.strictEqual(parsed.freezeAuthority, refParsed.freezeAuthority);
  console.log('  ✔ decimals/supply/authorities match');
}

console.log('\nSEMUA VERIFIKASI LULUS — spl-token.js identik dengan @solana/spl-token');

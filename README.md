# SOLLAUNCHPAD — Solana Token Launchpad (versi ringan)

Port **1:1** dari proyek `token-creator` (Next.js 14 + React + TypeScript + Tailwind + wallet-adapter)
menjadi **Node.js tanpa dependensi + HTML + CSS + Vanilla JavaScript**. Semua fitur, tab, teks,
nilai default, kunci `localStorage`, dan alur kerja dipertahankan sama persis — dan **semua fitur benar-benar
berfungsi end-to-end** (termasuk Raydium CPMM/CLMM, metadata Metaplex, dan revoke update authority yang di
versi asli masih placeholder / "coming soon"). Lihat [Catatan konversi](#catatan-konversi-penting-dibaca).

| | Versi asli (Next.js) | Versi ini (lite) |
|---|---|---|
| Framework | Next.js 14, React 18, TypeScript | Tidak ada — HTML + Vanilla JS |
| Styling | Tailwind CSS + PostCSS | `css/style.css` (vanilla, ±24 KB) |
| Wallet | `@solana/wallet-adapter-*` (4 paket) | `js/wallet.js` (±4 KB, Phantom & Solflare via provider injeksi) |
| SPL Token | `@solana/spl-token` | `js/spl-token.js` (±9 KB, **identik byte-per-byte** — ada skrip verifikasi) |
| Solana web3 | `@solana/web3.js` (di-bundle webpack) | `vendor/solana-web3.min.js` (IIFE resmi, 1 file) |
| Raydium SDK | di-bundle ke setiap halaman | `vendor/raydium-sdk.js` (1 MB) — **dimuat lazy** hanya saat tab Liquidity dibuka |
| Server | `next dev` / `next start` (ratusan MB `node_modules`) | `server.js` (modul bawaan Node, **0 dependensi**) |
| `npm install` untuk menjalankan | wajib | **tidak perlu** |

## Menjalankan

```bash
cd sollaunchpad-lite
node server.js          # → http://localhost:3000
# atau: npm start | PORT=8080 node server.js
```

Tidak ada langkah build dan tidak ada `npm install`. Folder `public/` juga bisa disajikan oleh
server statis apa pun (nginx, `python -m http.server`, dll). Gunakan `http://` (bukan `file://`)
agar ekstensi wallet (Phantom/Solflare) bisa meng-inject provider-nya.

## Struktur Proyek

```
sollaunchpad-lite/
├── server.js                 # Server statis ringan (http + fs + path), baca .env opsional
├── package.json              # scripts: start, test, build:vendor, verify
├── .env.example              # RPC_DEVNET / RPC_MAINNET / JUPITER_API_KEY (opsional)
├── .gitignore                # .env, node_modules, dan hasil uji lokal
├── public/
│   ├── index.html            # Dashboard: 8 tab (port dari TokenDashboard.tsx + AuthorityRevoker.tsx)
│   ├── css/style.css         # Tema cyberpunk/neon (pengganti Tailwind)
│   ├── js/
│   │   ├── config.js         # RPC URL, endpoint Jupiter, kunci localStorage
│   │   ├── amounts.js        # Konversi unit token presisi penuh (BigInt; tanpa floating-point)
│   │   ├── wallet.js         # Pengganti wallet-adapter (connect/disconnect/sign/send)
│   │   ├── spl-token.js      # Pengganti @solana/spl-token (instruksi yang dipakai dashboard)
│   │   ├── metaplex.js       # Metaplex Token Metadata: CreateMetadataAccountV3, CreateV1 (Token-2022), UpdateV2, baca metadata
│   │   ├── token-2022.js     # Port lib/token-2022.ts (+ metadata Metaplex, fee recipient = withdraw authority)
│   │   ├── raydium-cpmm.js   # Port lib/raydium-cpmm.ts — SDK Raydium asli (create pool / add / remove) 
│   │   ├── raydium-clmm.js   # Port lib/raydium-clmm.ts — SDK Raydium asli (create pool + posisi / add)
│   │   └── app.js            # Logika dashboard (state, render, handler)
│   └── vendor/
│       ├── solana-web3.min.js  # @solana/web3.js IIFE resmi
│       └── raydium-sdk.js      # Bundle @raydium-io/raydium-sdk-v2 + decimal.js + bn.js (lazy)
└── scripts/
    ├── build-vendor.js       # Rebuild file vendor (esbuild) — opsional
    ├── raydium-entry.js, buffer-shim.js
    ├── verify-spl-token.js   # Uji: spl-token.js identik dengan @solana/spl-token
    ├── tests/                # Unit/integration test Node bawaan (npm test; tanpa dependency tambahan)
    ├── e2e.js                # Uji UI headless (Playwright) dengan wallet simulasi, transaksi dicegat
    └── e2e-localnet.js       # Uji end-to-end NYATA: transaksi dikirim & diverifikasi di solana-test-validator
```

## Fitur (sama dengan versi asli)

| Fitur | Deskripsi |
|-------|-----------|
| **Create Token** | Buat SPL Token baru (nama, symbol, decimals, supply, metadata URI opsional). Nama/symbol/URI disimpan on-chain sebagai metadata Metaplex dalam transaksi yang sama |
| **Clone Token** | Ambil decimals, supply, **nama, symbol & URI metadata** dari mint sumber (`AMBIL DATA`; SPL Token maupun Token-2022), lalu buat token baru dengan metadata yang sama |
| **Copy Mint** | Tombol `[COPY]` di setiap hasil & baris Token List |
| **Jupiter Swap** | `GET QUOTE` → `EXECUTE SWAP` via Jupiter Swap API |
| **Liquidity CPMM** | Raydium CPMM — Create Pool (likuiditas awal dari AMOUNT A/B + PRICE A), Add Liquidity, Remove Liquidity (dengan MIN A/MIN B) |
| **Liquidity CLMM** | Raydium CLMM — Create Pool dengan rentang harga & fee tier (+ posisi awal bila AMOUNT diisi), Add Liquidity (buka posisi pada rentang harga form) |
| **Token-2022 Fee** | Token-2022 dengan transfer fee (basis points, max fee, recipient = withdraw-withheld authority) + metadata Metaplex; fee configuration immutable secara default, atau dapat diubah creator bila dipilih eksplisit |
| **Klaim Fee (baru)** | Kartu **KLAIM FEE TERTAHAN** di tab Token-2022: `CEK FEE` memindai semua akun token (fee bps, authority, total tertahan), `CLAIM FEE` menarik semuanya ke wallet FEE RECIPIENT (maks. 20 akun per transaksi, termasuk fee yang sudah di-harvest ke mint) |
| **Pakai token ini di… (baru)** | Setiap kotak hasil (Create/Clone/Token-2022) dan baris Token List punya tombol `→ POOL CPMM`, `→ POOL CLMM`, `→ REVOKE AUTHORITY` (+ `→ KLAIM FEE` untuk Token-2022) yang mengisi form tujuan otomatis (mint, decimals, pasangan WSOL) dan pindah tab |
| **Revoke Authority** | Cabut Mint Authority / Freeze Authority / **Metadata Update Authority** (metadata menjadi immutable) |
| **Token List** | Daftar token tersimpan di `localStorage` (`token-creator-tokens`) + `[WIPE ALL]` |
| **Tombol Pintasan DEX** | DexScreener, Birdeye, Raydium Swap, Jupiter Swap, Solana Explorer |
| **Wallet** | Phantom & Solflare (non-custodial), error handling, saldo SOL network terpilih (refresh otomatis / tombol refresh) |
| **Network Toggle** | DEVNET / MAINNET (tombol header + toggle melayang kanan-atas, keduanya dari kode asli) |

## Alur penggunaan (roadmap)

```
Jalur A — token biasa            Jalur B — token pajak (Token-2022)
CREATE TOKEN / CLONE TOKEN       TOKEN-2022 FEE  (mint BARU; fee tidak bisa ditambahkan ke token lama)
        │                                 │
        ▼                                 ▼
REVOKE AUTHORITY (mint, update)  REVOKE AUTHORITY (mint, update) ── fee tertahan → KLAIM FEE (FEE RECIPIENT)
        │                                 │
        ▼                                 ▼
LIQUIDITY CPMM / CLMM  ◄── tombol "→ POOL CPMM / → POOL CLMM" di setiap kotak hasil & Token List
```

- Token-2022 **bukan** otoritas dan bukan "upgrade" token yang sudah dibuat — ia program token berbeda; pajak transfer
  harus ditentukan saat mint dibuat.
- Pajak juga dipotong ketika token masuk pool (add liquidity, swap), sehingga rasio pool bergeser sedikit.
- Fee tidak langsung masuk wallet: fee *tertahan* di akun penerima dan ditarik lewat `CLAIM FEE` oleh FEE RECIPIENT.
- Supply SPL/Token-2022, jumlah swap, dan input likuiditas memakai konversi desimal eksak (`BigInt`); nilai dengan digit nonzero di luar decimals token atau di atas batas u64 ditolak. Untuk CPMM, hanya jumlah pasangan yang dihitung otomatis dari harga yang dibulatkan turun ke unit terkecil.
- Status wallet menampilkan native SOL pada network terpilih, melakukan polling tiap 30 detik, dan menyediakan tombol refresh manual. Jika RPC tidak dapat diakses, saldo ditandai `UNAVAILABLE` (bukan dianggap nol).

## Konfigurasi

- **RPC**: salin `.env.example` menjadi `.env`, lalu atur `RPC_DEVNET` / `RPC_MAINNET`; `server.js`
  menyuntikkan URL yang dipilih ke `config.js`. Untuk hosting statis, edit `public/js/config.js` langsung.
  Jika RPC mengembalikan HTTP 403, periksa jaringan yang dipilih, akses/API key/origin allowlist provider, dan batas pemakaian.
  Respons 403 berarti provider menolak request (berbeda dari mint yang tidak ditemukan). URL RPC di browser dapat dilihat pengunjung;
  gunakan key dengan pembatasan origin/referrer atau proxy RPC yang benar-benar berada di server.
- **Jupiter API**: `JUPITER_API` di `config.js`. Default `https://lite-api.jup.ag/swap/v1` (tanpa API key).
  Jupiter Swap dibatasi ke **mainnet-beta**; tombol quote tidak aktif di devnet. Jika memakai endpoint ber-key,
  set `JUPITER_API` ke `https://api.jup.ag/swap/v1` dan isi `JUPITER_API_KEY` di `config.js` atau `.env`.
  Key itu juga dikirim ke browser, jadi gunakan key yang dibatasi origin. Endpoint lama `quote-api.jup.ag/v6`
  sudah dimatikan; aplikasi memakai endpoint Swap API v1.

## Memperbarui file vendor (opsional)

Hanya jika ingin menaikkan versi web3.js / Raydium SDK:

```bash
npm install            # devDependencies (esbuild, raydium-sdk-v2, dll.)
npm run build:vendor   # tulis ulang public/vendor/*.js
npm run verify         # pastikan spl-token.js masih identik dengan @solana/spl-token
```

## Pengujian

- `npm test` — tes unit/integrasi Node bawaan (konversi token eksak, config injection, path traversal, HTTP method, dan error URL), tanpa Playwright atau akses RPC.
- `npm run verify` — membandingkan byte instruksi `spl-token.js` dengan library resmi
  (InitializeMint, CreateATA, MintTo, SetAuthority, InitializeTransferFeeConfig, ATA, getMintLen, unpackMint).
- `node scripts/e2e.js` (butuh `npm i -D playwright && npx playwright install chromium`, server harus jalan) —
  membuka dashboard di Chromium headless dengan wallet Phantom simulasi, menjalankan Create/Clone/Token-2022/
  Revoke/Swap/List, lalu memverifikasi transaksi yang ditandatangani (RPC read-only ke devnet asli,
  `sendTransaction` dicegat sehingga tidak butuh SOL).
- `node scripts/e2e-localnet.js` — uji **nyata** terhadap `solana-test-validator` yang meng-clone program Raydium
  CPMM/CLMM devnet + Metaplex (perintah lengkap ada di kepala file). Skrip menjalankan server uji sendiri di port 3001
  dengan `RPC_DEVNET=http://127.0.0.1:8899`, lalu dari browser: Create Token (+metadata) → Clone (baca metadata) →
  Token-2022 (fee config + metadata) → klaim fee (ditolak untuk bukan-authority; sukses untuk FEE RECIPIENT, saldo
  diverifikasi) → tombol "pakai token ini di…" → Revoke update/mint/freeze → CPMM create/add/remove → CLMM
  create+posisi/add, dan memverifikasi setiap hasil langsung on-chain (akun mint, metadata, konfigurasi fee, akun pool).

## Catatan konversi (penting dibaca)

Fungsi dan tampilan dipertahankan 1:1. Saat memindahkan kode, ditemukan beberapa bug di versi Next.js yang
membuat fitur **tidak mungkin berjalan sama sekali**; bagian ini diperbaiki agar fungsinya benar-benar bekerja:

1. **Connect Wallet** — kode asli memanggil `wallet.connect()` tanpa pernah `select()` wallet, sehingga selalu
   error `No wallet adapter available`. Sekarang Phantom/Solflare dideteksi dan bisa dipilih langsung.
2. **Create / Clone Token** — keypair mint tidak ikut menandatangani (`SystemProgram.createAccount`
   mewajibkan tanda tangan akun baru) dan urutan argumen `createAssociatedTokenAccountInstruction` terbalik.
   Sekarang `tx.partialSign(mintKeypair)` + argumen benar (`payer, ata, owner, mint`).
3. **Token-2022 Fee** — ukuran akun memakai `MINT_SIZE` (82) padahal perlu 278 byte dengan extension, dan
   `InitializeTransferFeeConfig` dipasang *setelah* `InitializeMint` (harus sebelum). Keduanya dibetulkan.
4. **Revoke Authority** — kode asli mengimpor `createRevokeMintInstruction`/`createRevokeFreezeAuthorityInstruction`
   yang tidak ada di `@solana/spl-token`. Diimplementasikan dengan `SetAuthority(MintTokens|FreezeAccount → null)`
   (cara resmi), otomatis memakai program pemilik mint (SPL Token atau Token-2022).
5. **Jupiter** — endpoint v6 sudah mati (lihat Konfigurasi). Parameter, alur, dan tampilan quote tetap sama.
6. **Tombol EXECUTE SWAP** berada di dalam `<form>` tanpa `type="button"` sehingga me-reload halaman; kini `type="button"`.

Fitur yang di versi asli masih *placeholder* dan kini **diimplementasikan penuh** (diuji end-to-end di
`solana-test-validator` dengan program Raydium devnet + Metaplex yang di-clone, lihat `scripts/e2e-localnet.js`):

7. **Raydium CPMM** (`raydium-cpmm.js`) — memakai `@raydium-io/raydium-sdk-v2` asli: program id & akun fee dari
   konstanta SDK (mainnet `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`, devnet `DRaycpLY18…`; id lama di kode
   asli `CPMMoo8L3F4NbT6BCKFpa8w6qh6W7m4s4g2y8bQwFz` tidak valid), fee config diambil dari API/PDA, likuiditas awal
   dari AMOUNT A/B (yang kosong dihitung dari PRICE A), **Add/Remove** menghitung pasangan jumlah dari rasio pool
   (slippage 1 %) dan menolak input yang tidak cukup dengan pesan jelas (`AMOUNT B tidak cukup: dibutuhkan ≈ …`,
   `MIN A … melebihi estimasi`). Program CPMM mengurutkan mint, jadi orientasi A/B selalu mengikuti **MINT A di form**.
8. **Raydium CLMM** (`raydium-clmm.js`) — create pool dengan fee tier nyata (0.01 % / 0.05 % / 0.25 % / 1 %; devnet
   hanya punya tiga pertama, selebihnya memakai config terdekat), rentang harga → tick dibulatkan ke `tickSpacing`
   (dibalik otomatis bila urutan mint tertukar), posisi awal dibuka bila AMOUNT A/B diisi (NFT posisi Token-2022),
   **Add Liquidity** membuka posisi pada rentang harga form (tick-tick kode asli `price*1000` salah). SDK bug
   `getPoolInfoFromRpc` pada pool baru tanpa tick array dihindari dengan `getSimplePoolInfo`.
9. **Metadata Metaplex** (`metaplex.js`, ±9 KB, tanpa library) — Create Token & Clone menulis nama/symbol/URI
   on-chain (`CreateMetadataAccountV3`), Token-2022 memakai `Create V1` (V3 ditolak program untuk mint Token-2022),
   Clone membaca metadata sumber (sebelumnya selalu "Cloned Token"/"CLONE"), dan **Revoke Update Authority**
   benar-benar jalan (`UpdateMetadataAccountV2{isMutable:false}` — permanen).
10. **Token-2022 Fee** — `FEE RECIPIENT` kini menjadi *withdraw-withheld authority* (di versi asli hanya tampilan),
    `MAX FEE = 0` berarti tanpa cap (`u64::MAX`; nilai 0 literal justru membuat fee selalu 0), nama & symbol tersimpan
    sebagai metadata. Fee yang tertahan di akun penerima dapat ditarik authority dengan
    `spl-token withdraw-withheld-tokens <MINT> <TUJUAN>` (UI klaim fee tidak ada di versi asli, tidak ditambahkan).
11. **Revoke Mint/Freeze** memeriksa authority saat ini lebih dulu sehingga pesan error jelas
    (mis. "Freeze authority token ini sudah tidak ada") alih-alih `custom program error`.
12. Pembungkus Raydium menunggu konfirmasi transaksi secara eksplisit (SDK hanya mengirim saat memakai wallet)
    dan menyegarkan cache token account sebelum setiap aksi.
13. **Klaim fee Token-2022** — `spl-token.js` ditambah `WithdrawWithheldTokensFromAccounts`, `…FromMint`,
    `HarvestWithheldTokensToMint`, `unpackAccount`, `getTransferFeeAmount`, `getTransferFeeConfig` (semuanya diverifikasi
    identik dengan `@solana/spl-token`). Pemindaian memakai `getProgramAccounts` (memcmp mint); bila RPC menolaknya,
    otomatis jatuh ke `getTokenLargestAccounts` (20 akun terbesar) dan ditandai di hasil pemeriksaan.
14. Label `MAX FEE` diperjelas: satuannya unit terkecil token (10^decimals), bukan lamports SOL.

Yang sengaja **dipertahankan apa adanya** (sama persis dengan asli):

- Semua label, teks bantuan, nilai default form, format hasil (mis. `LAUNCH MAINNET-BETA`, output swap dibagi `1e6`),
  dan toggle jaringan melayang dari `WalletProvider.tsx` (hapus blok `<div class="floating-network">` di
  `index.html` bila tidak diinginkan).
- `components/TokenCreatorForm.tsx` di proyek asli **tidak pernah dirender** (tidak di-import `page.tsx`),
  jadi tidak diikutkan.

## Keamanan

- **Non-custodial:** private key & dana user tidak pernah disimpan di server/web
- Semua transaksi ditandatangani melalui wallet (Phantom/Solflare) dan dikirim ke RPC jaringan yang dipilih
- Tidak ada hardcoded private key di frontend
- RPC/Jupiter API keys yang diatur melalui config server disajikan ke browser; key tersebut bukan rahasia dan harus dibatasi berdasarkan origin
- Devnet & Mainnet terpisah untuk mencegah kesalahan jaringan

## Peringatan

- Transaksi blockchain **tidak dapat dibatalkan**
- Mainnet menggunakan SOL asli — pastikan memahami risiko sebelum launch
- Liquidity pool memiliki risiko impermanent loss

## Lisensi

MIT

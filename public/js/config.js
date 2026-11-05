/**
 * config.js — Konfigurasi dashboard (bisa diedit langsung).
 * Jika dijalankan lewat server.js, nilai RPC bisa di-override dari file .env
 * (RPC_DEVNET / RPC_MAINNET) — lihat .env.example.
 */
window.APP_CONFIG = {
  RPC_URLS: {
    devnet: 'https://api.devnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  },

  WRAPPED_SOL: 'So11111111111111111111111111111111111111112',
  NATIVE_SOL: '11111111111111111111111111111111',

  // Jupiter Swap API.
  // Endpoint lama "https://quote-api.jup.ag/v6" sudah dimatikan Jupiter (1 Okt 2025).
  // Pengganti resmi tanpa API key: lite-api.jup.ag/swap/v1 (skema quote/swap sama persis).
  JUPITER_API: 'https://lite-api.jup.ag/swap/v1',

  // Kunci localStorage (sama dengan versi Next.js agar data lama tetap terbaca)
  STORAGE_TOKENS: 'token-creator-tokens',
  STORAGE_WALLET: 'token-creator',
};

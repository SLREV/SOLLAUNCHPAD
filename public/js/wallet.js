/**
 * wallet.js — Konektor wallet ringan (pengganti @solana/wallet-adapter).
 * Mendukung Phantom & Solflare (non-custodial) lewat provider yang di-inject
 * ekstensi browser. API-nya meniru useWallet():
 *   publicKey, connected, connecting, connect(), disconnect(),
 *   signTransaction(tx), sendTransaction(tx, connection)
 */
(function (root) {
  'use strict';

  const CFG = root.APP_CONFIG;
  const web3 = root.solanaWeb3;

  const state = {
    name: null,        // 'Phantom' | 'Solflare'
    provider: null,
    publicKey: null,   // solanaWeb3.PublicKey
    connected: false,
    connecting: false,
  };
  const listeners = new Set();

  function emit() {
    listeners.forEach((fn) => {
      try { fn(snapshot()); } catch (e) { console.error(e); }
    });
  }

  function snapshot() {
    return {
      name: state.name,
      publicKey: state.publicKey,
      connected: state.connected,
      connecting: state.connecting,
    };
  }

  /** Deteksi wallet yang terpasang di browser */
  function detect() {
    const phantom =
      (root.phantom && root.phantom.solana && root.phantom.solana.isPhantom && root.phantom.solana) ||
      (root.solana && root.solana.isPhantom && root.solana) ||
      null;
    const solflare = (root.solflare && root.solflare.isSolflare && root.solflare) || null;
    return [
      { name: 'Phantom', provider: phantom, installed: !!phantom, url: 'https://phantom.app/' },
      { name: 'Solflare', provider: solflare, installed: !!solflare, url: 'https://solflare.com/' },
    ];
  }

  function toPublicKey(pk) {
    if (!pk) return null;
    return new web3.PublicKey(pk.toString());
  }

  function attachEvents(provider) {
    if (!provider || !provider.on || provider.__sllpBound) return;
    provider.__sllpBound = true;
    provider.on('disconnect', () => {
      if (state.provider === provider) {
        state.connected = false;
        state.publicKey = null;
        emit();
      }
    });
    provider.on('accountChanged', (pk) => {
      if (state.provider !== provider) return;
      if (pk) {
        state.publicKey = toPublicKey(pk);
      } else {
        state.connected = false;
        state.publicKey = null;
      }
      emit();
    });
  }

  /**
   * Connect ke wallet. `name` = 'Phantom' | 'Solflare'.
   * Jika tidak ada wallet terpasang → Error('No wallet adapter available')
   */
  async function connect(name) {
    const wallets = detect();
    const chosen = name ? wallets.find((w) => w.name === name) : wallets.find((w) => w.installed);
    if (!chosen || !chosen.installed) {
      throw new Error('No wallet adapter available');
    }
    state.connecting = true;
    emit();
    try {
      const provider = chosen.provider;
      const res = await provider.connect();
      const pk = (res && res.publicKey) || provider.publicKey;
      if (!pk) throw new Error('Wallet did not return a public key');
      state.provider = provider;
      state.name = chosen.name;
      state.publicKey = toPublicKey(pk);
      state.connected = true;
      attachEvents(provider);
      try { localStorage.setItem(CFG.STORAGE_WALLET, chosen.name); } catch (_) { /* ignore */ }
      return state.publicKey;
    } finally {
      state.connecting = false;
      emit();
    }
  }

  async function disconnect() {
    const p = state.provider;
    state.connected = false;
    state.publicKey = null;
    state.provider = null;
    state.name = null;
    emit();
    if (p && p.disconnect) {
      try { await p.disconnect(); } catch (e) { console.error(e); }
    }
  }

  function requireProvider() {
    if (!state.provider || !state.connected) throw new Error('Wallet not connected');
    return state.provider;
  }

  /** Tanda tangani Transaction / VersionedTransaction via wallet (tanpa mengirim) */
  async function signTransaction(tx) {
    const provider = requireProvider();
    return provider.signTransaction(tx);
  }

  /**
   * Tanda tangani lalu kirim ke RPC `connection` (jaringan yang dipilih di dashboard,
   * bukan RPC bawaan wallet) — setara sendTransaction() milik wallet-adapter.
   */
  async function sendTransaction(tx, connection, options) {
    const provider = requireProvider();
    const signed = await provider.signTransaction(tx);
    if (!signed) throw new Error('Sign failed');
    const raw = signed.serialize();
    return connection.sendRawTransaction(raw, Object.assign({ preflightCommitment: 'confirmed' }, options || {}));
  }

  root.Wallet = {
    detect,
    connect,
    disconnect,
    signTransaction,
    sendTransaction,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getState: snapshot,
    get publicKey() { return state.publicKey; },
    get connected() { return state.connected; },
    get connecting() { return state.connecting; },
    get name() { return state.name; },
  };
})(window);

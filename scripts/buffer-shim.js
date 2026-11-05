// Shim: menyediakan Buffer global untuk dependensi Raydium SDK di browser.
import { Buffer } from 'buffer';
if (typeof window !== 'undefined' && !window.Buffer) window.Buffer = Buffer;
export { Buffer };

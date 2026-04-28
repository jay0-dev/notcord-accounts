// Phase J5 — browser-side cryptographic key generation for the
// /register flow. Produces:
//   - identity_key: 32 raw bytes of an Ed25519 public key (the
//     proto's `RegisterRequest.identity_key`).
//   - mlkem_ek: 1184 bytes of an ML-KEM-768 encapsulation key
//     (the proto's `RegisterRequest.mlkem_ek`).
//
// Private keys are persisted to IndexedDB encrypted with an
// AES-GCM key derived from the user's password (PBKDF2). When the
// desktop client signs in for the first time it claims the
// account by re-deriving the same key from the password and
// importing the encrypted blobs via a pairing flow (separate phase).

import { ml_kem768 } from "/vendor/ml-kem.js";

// Web Crypto Ed25519 support: Chrome 113+, Firefox 130+, Safari
// 17+. The catch block below throws a friendly error in older
// environments.
async function generateEd25519Pair() {
  let pair;
  try {
    pair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    );
  } catch (e) {
    throw new Error(
      "This browser doesn't support Ed25519 in WebCrypto. Update Chrome/Firefox/Safari to a recent version."
    );
  }

  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pub, priv };
}

function generateMlKemPair() {
  // noble's ml_kem768 returns Uint8Arrays for both publicKey
  // (1184 bytes) and secretKey (2400 bytes).
  const seed = crypto.getRandomValues(new Uint8Array(64));
  return ml_kem768.keygen(seed);
}

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Derive an AES-GCM key from the user's password via PBKDF2.
async function deriveStorageKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptBlob(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveStorageKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );

  // Layout: salt(16) | iv(12) | ciphertext.
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(ct, salt.length + iv.length);
  return out;
}

async function persistEncryptedBlob(name, blob) {
  // Open the keystore IndexedDB, store the blob keyed by name.
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("hexis-keys", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("blobs");
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("blobs", "readwrite");
      tx.objectStore("blobs").put(blob, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

// Top-level entrypoint called from the /register form submit
// handler. Returns the wire-format keys (b64) plus persists the
// private material locally.
export async function generateAccountKeys(password) {
  const { pub: idPub, priv: idPrivJwk } = await generateEd25519Pair();
  const { publicKey: ekPub, secretKey: ekPriv } = generateMlKemPair();

  const idPrivBytes = new TextEncoder().encode(JSON.stringify(idPrivJwk));
  const idEnc = await encryptBlob(idPrivBytes, password);
  const ekEnc = await encryptBlob(ekPriv, password);

  await persistEncryptedBlob("ed25519", idEnc);
  await persistEncryptedBlob("mlkem768", ekEnc);

  return {
    identity_key_b64: bytesToBase64(idPub),
    mlkem_ek_b64: bytesToBase64(ekPub),
  };
}

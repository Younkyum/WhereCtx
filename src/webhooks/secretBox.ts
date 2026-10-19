/**
 * Optional at-rest encryption for webhook signing secrets (review finding H2).
 *
 * Token secrets are one-way hashed, but webhook signing secrets must be
 * recoverable at delivery time to compute the HMAC, so they are encrypted
 * instead: AES-256-GCM with a key derived from WEBHOOK_ENCRYPTION_KEY via
 * SHA-256. Ciphertexts are stored as "enc:v1:" + base64(iv | authTag | ct).
 * Values without the prefix are treated as legacy plaintext so existing rows
 * keep working when a key is introduced later (they are re-encrypted on boot).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = createHash("sha256").update(keyMaterial, "utf8").digest();
  }

  /** `aad` binds the ciphertext to a context (a row's owner): decrypting it under another fails. */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
  }

  /** Decrypt a stored value; legacy plaintext (no prefix) is returned as-is. */
  decrypt(stored: string, aad?: string): string {
    if (!isEncryptedSecret(stored)) return stored;
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    if (buf.length < IV_LEN + TAG_LEN) {
      throw new Error("malformed encrypted secret");
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}

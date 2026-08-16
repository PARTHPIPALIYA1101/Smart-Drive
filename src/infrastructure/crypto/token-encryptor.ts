import * as crypto from 'node:crypto';

export interface ITokenEncryptor {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export class TokenEncryptor implements ITokenEncryptor {
  private readonly key: Buffer;
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96 bits recommended for GCM
  private static readonly AUTH_TAG_LENGTH = 16; // 128 bits

  constructor(encryptionKeyHex?: string) {
    const rawKey = encryptionKeyHex || process.env.ENCRYPTION_KEY;
    if (!rawKey) {
      // Default deterministic local development key (32 bytes / 256 bits)
      this.key = crypto.createHash('sha256').update('smart-drive-default-local-key-2026').digest();
    } else {
      if (rawKey.length === 64) {
        this.key = Buffer.from(rawKey, 'hex');
      } else {
        this.key = crypto.createHash('sha256').update(rawKey).digest();
      }
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(TokenEncryptor.IV_LENGTH);
    const cipher = crypto.createCipheriv(TokenEncryptor.ALGORITHM, this.key, iv, {
      authTagLength: TokenEncryptor.AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted (in hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted token payload format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(TokenEncryptor.ALGORITHM, this.key, iv, {
      authTagLength: TokenEncryptor.AUTH_TAG_LENGTH,
    });

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }
}

import { describe, it, expect } from 'vitest';
import { TokenEncryptor } from '../../src/infrastructure/crypto/token-encryptor.js';

describe('TokenEncryptor (AES-256-GCM)', () => {
  const encryptor = new TokenEncryptor();

  it('encrypts and decrypts strings correctly', () => {
    const secret = JSON.stringify({
      accessToken: 'ya29.a0AfH6SM...',
      refreshToken: '1//0gJ8_...',
      expiresAt: 1723812000000,
    });

    const encrypted = encryptor.encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext

    const decrypted = encryptor.decrypt(encrypted);
    expect(decrypted).toBe(secret);
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(secret));
  });

  it('produces distinct ciphertexts for identical plaintext (unique IV per encryption)', () => {
    const plaintext = 'sample-refresh-token';
    const enc1 = encryptor.encrypt(plaintext);
    const enc2 = encryptor.encrypt(plaintext);

    expect(enc1).not.toBe(enc2);
    expect(encryptor.decrypt(enc1)).toBe(plaintext);
    expect(encryptor.decrypt(enc2)).toBe(plaintext);
  });

  it('rejects tampered ciphertexts and invalid auth tags', () => {
    const plaintext = 'sensitive-google-token';
    const encrypted = encryptor.encrypt(plaintext);
    const parts = encrypted.split(':');

    // Tamper with ciphertext
    const tamperedCipher = parts[0] + ':' + parts[1] + ':' + parts[2].slice(0, -2) + 'ff';
    expect(() => encryptor.decrypt(tamperedCipher)).toThrow();

    // Tamper with auth tag
    const tamperedTag = parts[0] + ':' + '00112233445566778899aabbccddeeff' + ':' + parts[2];
    expect(() => encryptor.decrypt(tamperedTag)).toThrow();
  });
});

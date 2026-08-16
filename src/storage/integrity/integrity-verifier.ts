import { ProviderFileMetadata } from '../../providers/storage-provider.interface.js';
import { VerificationFailedError } from '../../domain/errors.js';

export class IntegrityVerifier {
  /**
   * Verifies destination file integrity against expected source metadata.
   */
  static verify(
    expected: { size: number; checksum?: string | null; checksumType?: string | null },
    actual: ProviderFileMetadata
  ): boolean {
    // 1. Verify byte size exact match
    if (actual.size !== expected.size) {
      throw new VerificationFailedError(
        `File size mismatch during migration verification. Expected: ${expected.size} bytes, Actual: ${actual.size} bytes.`,
        { expectedSize: expected.size, actualSize: actual.size }
      );
    }

    // 2. Verify checksum match if available on both source and destination
    if (
      expected.checksum &&
      actual.checksum &&
      expected.checksumType &&
      actual.checksumType &&
      expected.checksumType === actual.checksumType &&
      expected.checksumType !== 'NONE'
    ) {
      if (expected.checksum.toLowerCase() !== actual.checksum.toLowerCase()) {
        throw new VerificationFailedError(
          `Checksum mismatch during migration verification. Expected: ${expected.checksum}, Actual: ${actual.checksum}.`,
          { expectedChecksum: expected.checksum, actualChecksum: actual.checksum }
        );
      }
    }

    return true;
  }
}

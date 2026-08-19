export const ResourceLimits = {
  // Upload Concurrency: Bounded concurrent active physical transfers
  MAX_CONCURRENT_UPLOADS: parseInt(process.env.MAX_CONCURRENT_UPLOADS || '3', 10),

  // Disconnect Grace Period: Duration in ms before disconnected client transfer is cancelled
  DISCONNECT_GRACE_PERIOD_MS: parseInt(process.env.DISCONNECT_GRACE_PERIOD_MS || '10000', 10),

  // Progress Persistence: Minimum interval in ms between database updates for high-frequency progress
  PROGRESS_PERSIST_INTERVAL: parseInt(process.env.PROGRESS_PERSIST_INTERVAL || '5000', 10),

  // Quota Caching: Duration in ms to cache Google Drive quota before querying remote API
  QUOTA_REFRESH_INTERVAL: parseInt(process.env.QUOTA_REFRESH_INTERVAL || '600000', 10),

  // Stream Buffer Chunk: Bounded stream chunk size for I/O backpressure (64 KB)
  MAX_STREAM_BUFFER_SIZE: 64 * 1024,

  // SQLite PRAGMA configuration
  SQLITE_BUSY_TIMEOUT_MS: 5000,
  WAL_AUTOCHECKPOINT_PAGES: 1000,
};

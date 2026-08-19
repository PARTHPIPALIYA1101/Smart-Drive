import 'dotenv/config';
import { createDatabaseConnection } from './persistence/db.js';
import { runMigrations } from './persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
  StorageOperationRepository,
  StorageReservationRepository,
  FileMigrationRepository,
} from './persistence/repositories/index.js';
import { VirtualFilesystemService } from './domain/vfs/vfs.service.js';
import { CapacityService } from './domain/capacity/capacity.service.js';
import { DriveSyncService } from './application/sync/drive-sync.service.js';
import { DriveImportService } from './application/sync/drive-import.service.js';
import { TransferService } from './domain/transfer/transfer.service.js';
import { StoragePlanner } from './storage/planner/storage-planner.js';
import { MigrationPlanner } from './storage/migration/migration-planner.js';
import { MigrationExecutor } from './storage/migration/migration-executor.js';
import { CrashRecoveryEngine } from './storage/recovery/recovery-engine.js';
import { SearchService } from './search/search.service.js';
import { StorageStatsService } from './domain/stats/stats.service.js';
import { TransferProgressTracker } from './domain/transfer/progress-tracker.js';
import { DriveRetirementService } from './application/retirement/retirement.service.js';
import { StorageProviderFactory } from './providers/provider-factory.js';
import { TokenEncryptor } from './infrastructure/crypto/token-encryptor.js';
import { GoogleOAuthService } from './providers/google-drive/auth/google-oauth.service.js';
import { AccountService } from './application/account/account.service.js';
import { ReservationManager, ReservationReaper } from './storage/reservation/index.js';
import { DomainEventBus } from './domain/events/event-bus.js';
import { UploadQueue } from './domain/transfer/upload-queue.js';
import { TransferSessionManager } from './domain/transfer/transfer-session-manager.js';
import { createServer, AppServices } from './api/server.js';

export async function bootstrap() {
  const dbPath = process.env.DATABASE_PATH || './smart_drive.db';
  const conn = createDatabaseConnection(dbPath);
  runMigrations(conn);

  const fileRepo = new FileRepository(conn.db);
  const locationRepo = new FileLocationRepository(conn.db);
  const accountRepo = new GoogleAccountRepository(conn.db);
  const opRepo = new StorageOperationRepository(conn.db);
  const resRepo = new StorageReservationRepository(conn.db);
  const migRepo = new FileMigrationRepository(conn.db);

  const eventBus = new DomainEventBus();
  const vfsService = new VirtualFilesystemService(fileRepo, eventBus);
  const capacityService = new CapacityService(accountRepo, resRepo);
  const encryptor = new TokenEncryptor(process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY);

  const oauthService = new GoogleOAuthService(
    {
      clientId: process.env.GOOGLE_CLIENT_ID || 'client-id-placeholder',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'client-secret-placeholder',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
    },
    encryptor,
    accountRepo
  );

  const providerFactory = new StorageProviderFactory(oauthService);

  const sessionManager = new TransferSessionManager(
    opRepo,
    resRepo,
    providerFactory,
    eventBus
  );

  const accountService = new AccountService(accountRepo, oauthService, encryptor, eventBus);
  const driveSyncService = new DriveSyncService(
    accountRepo,
    providerFactory,
    accountService,
    capacityService
  );
  const driveImportService = new DriveImportService(
    conn.db,
    fileRepo,
    locationRepo,
    accountRepo,
    providerFactory
  );
  const transferService = new TransferService(
    fileRepo,
    locationRepo,
    accountRepo,
    opRepo,
    resRepo,
    capacityService,
    providerFactory,
    eventBus,
    sessionManager
  );
  const uploadQueue = new UploadQueue(transferService, opRepo, eventBus, vfsService);
  const storagePlanner = new StoragePlanner(capacityService, fileRepo, locationRepo, opRepo);
  const migrationPlanner = new MigrationPlanner(
    capacityService,
    fileRepo,
    locationRepo,
    accountRepo,
    opRepo
  );
  const reservationManager = new ReservationManager(conn.db);
  const migrationExecutor = new MigrationExecutor(
    fileRepo,
    locationRepo,
    accountRepo,
    opRepo,
    migRepo,
    reservationManager,
    providerFactory
  );
  const recoveryEngine = new CrashRecoveryEngine(
    opRepo,
    resRepo,
    locationRepo,
    migRepo,
    accountRepo,
    providerFactory
  );
  const searchService = new SearchService(conn.db, vfsService);
  const statsService = new StorageStatsService(
    conn.db,
    fileRepo,
    accountRepo,
    locationRepo,
    opRepo,
    migRepo,
    capacityService
  );
  const progressTracker = new TransferProgressTracker();
  const retirementService = new DriveRetirementService(
    accountRepo,
    migrationPlanner,
    migrationExecutor
  );

  // 1. Reconcile startup state (Crash Recovery)
  const recoveryReport = await recoveryEngine.reconcileStartupState();
  if (recoveryReport.recoveredCount > 0) {
    console.log(`[SmartDrive] Reconciled ${recoveryReport.recoveredCount} incomplete operations on startup.`);
  }

  // 2. Start Reservation Reaper
  const reaper = new ReservationReaper(reservationManager, 60000);
  reaper.start();

  const services: AppServices = {
    vfsService,
    accountService,
    oauthService,
    capacityService,
    statsService,
    driveSyncService,
    driveImportService,
    transferService,
    uploadQueue,
    storagePlanner,
    migrationPlanner,
    migrationExecutor,
    recoveryEngine,
    searchService,
    progressTracker,
    retirementService,
    operationRepo: opRepo,
    eventBus,
    sessionManager,
  };

  const server = createServer(services);
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  return { server, port, services, conn, reaper };
}

if (process.env.NODE_ENV !== 'test' && import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  bootstrap().then(({ server, port }) => {
    server.listen({ port, host: '0.0.0.0' }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`🚀 Smart Drive Server listening at ${address}`);
    });
  });
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  GoogleAccountRepository,
  StorageReservationRepository,
  StorageOperationRepository,
} from '../../src/persistence/repositories/index.js';
import { ReservationManager } from '../../src/storage/reservation/reservation-manager.js';
import { ReservationReaper } from '../../src/storage/reservation/reservation-reaper.js';
import { StoragePlan } from '../../src/storage/planner/planner.types.js';
import { ReservationConflictError } from '../../src/domain/errors.js';

describe('ReservationManager & Concurrency Lockout Suite', () => {
  let conn: DatabaseConnection;
  let accountRepo: GoogleAccountRepository;
  let resRepo: StorageReservationRepository;
  let opRepo: StorageOperationRepository;
  let resManager: ReservationManager;
  let reaper: ReservationReaper;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    accountRepo = new GoogleAccountRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resManager = new ReservationManager(conn.db);
    reaper = new ReservationReaper(resManager, 1000);
  });

  afterEach(() => {
    reaper.stop();
    conn.close();
  });

  it('atomically acquires batch reservations across multiple drives for a plan', () => {
    const now = Date.now();
    const driveA = accountRepo.insert({
      email: 'driveA@test.com',
      displayName: 'Drive A',
      totalSpace: 20000,
      usedSpace: 5000,
      freeSpace: 15000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const driveB = accountRepo.insert({
      email: 'driveB@test.com',
      displayName: 'Drive B',
      totalSpace: 20000,
      usedSpace: 5000,
      freeSpace: 15000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const mockPlan: StoragePlan = {
      planId: 'PLAN-1',
      operationType: 'UPLOAD',
      targetDriveId: driveA.id,
      placementPolicy: 'BALANCED_HEURISTIC',
      requiresMigration: true,
      score: 800,
      migrationSteps: [],
      capacityReservations: [
        { driveId: driveA.id, reservedBytes: 10000, reason: 'INCOMING_UPLOAD' },
        { driveId: driveB.id, reservedBytes: 4000, reason: 'MIGRATION_DESTINATION' },
      ],
      expectedFinalState: {
        targetDriveUsableAfter: 5000,
        destinationDrivesUsableAfter: { [driveB.id]: 11000 },
      },
      rejectedAlternatives: [],
      rationale: 'Test multi-drive plan',
    };

    opRepo.insert({
      id: 'OP-BATCH-1',
      operationType: 'UPLOAD',
      status: 'RESERVED',
      requestedBytes: 10000,
      createdAt: now,
    });

    const reservations = resManager.acquirePlanReservations(mockPlan, 'OP-BATCH-1');
    expect(reservations).toHaveLength(2);

    expect(resRepo.calculateActiveReservedBytes(driveA.id)).toBe(10000);
    expect(resRepo.calculateActiveReservedBytes(driveB.id)).toBe(4000);
  });

  it('detects concurrent stale plan conflict and rolls back all reservations atomically', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'contention@test.com',
      displayName: 'Contention Drive',
      totalSpace: 10000,
      usedSpace: 0,
      freeSpace: 10000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const plan1: StoragePlan = {
      planId: 'PLAN-1',
      operationType: 'UPLOAD',
      targetDriveId: drive.id,
      placementPolicy: 'MAX_USABLE_FREE_SPACE',
      requiresMigration: false,
      score: 10000,
      migrationSteps: [],
      capacityReservations: [{ driveId: drive.id, reservedBytes: 7000, reason: 'INCOMING_UPLOAD' }],
      expectedFinalState: { targetDriveUsableAfter: 3000, destinationDrivesUsableAfter: {} },
      rejectedAlternatives: [],
      rationale: 'Op 1',
    };

    const plan2: StoragePlan = {
      planId: 'PLAN-2',
      operationType: 'UPLOAD',
      targetDriveId: drive.id,
      placementPolicy: 'MAX_USABLE_FREE_SPACE',
      requiresMigration: false,
      score: 10000,
      migrationSteps: [],
      capacityReservations: [{ driveId: drive.id, reservedBytes: 6000, reason: 'INCOMING_UPLOAD' }],
      expectedFinalState: { targetDriveUsableAfter: 4000, destinationDrivesUsableAfter: {} },
      rejectedAlternatives: [],
      rationale: 'Op 2',
    };

    opRepo.insert({
      id: 'OP-1',
      operationType: 'UPLOAD',
      status: 'RESERVED',
      requestedBytes: 7000,
      createdAt: now,
    });

    opRepo.insert({
      id: 'OP-2',
      operationType: 'UPLOAD',
      status: 'RESERVED',
      requestedBytes: 6000,
      createdAt: now,
    });

    // Operation 1 acquires 7000 B
    resManager.acquirePlanReservations(plan1, 'OP-1');
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(7000);

    // Operation 2 attempts to acquire 6000 B (Only 3000 B usable remains!)
    expect(() => {
      resManager.acquirePlanReservations(plan2, 'OP-2');
    }).toThrow(ReservationConflictError);

    // Verify Op 2 left zero reservations in DB (Atomicity preserved)
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(7000);
  });

  it('releases and commits reservations cleanly', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'release_test@test.com',
      displayName: 'Release Drive',
      totalSpace: 10000,
      usedSpace: 0,
      freeSpace: 10000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const plan: StoragePlan = {
      planId: 'PLAN-REL',
      operationType: 'UPLOAD',
      targetDriveId: drive.id,
      placementPolicy: 'MAX_USABLE_FREE_SPACE',
      requiresMigration: false,
      score: 10000,
      migrationSteps: [],
      capacityReservations: [{ driveId: drive.id, reservedBytes: 5000, reason: 'INCOMING_UPLOAD' }],
      expectedFinalState: { targetDriveUsableAfter: 5000, destinationDrivesUsableAfter: {} },
      rejectedAlternatives: [],
      rationale: 'Test release',
    };

    opRepo.insert({
      id: 'OP-REL',
      operationType: 'UPLOAD',
      status: 'RESERVED',
      requestedBytes: 5000,
      createdAt: now,
    });

    resManager.acquirePlanReservations(plan, 'OP-REL');
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(5000);

    // Release operation
    const releasedCount = resManager.releasePlanReservations('OP-REL');
    expect(releasedCount).toBe(1);
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(0);
  });

  it('ReservationReaper expires stale reservations when TTL passes', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'reaper@test.com',
      displayName: 'Reaper Drive',
      totalSpace: 10000,
      usedSpace: 0,
      freeSpace: 10000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const plan: StoragePlan = {
      planId: 'PLAN-EXPIRE',
      operationType: 'UPLOAD',
      targetDriveId: drive.id,
      placementPolicy: 'MAX_USABLE_FREE_SPACE',
      requiresMigration: false,
      score: 10000,
      migrationSteps: [],
      capacityReservations: [{ driveId: drive.id, reservedBytes: 4000, reason: 'INCOMING_UPLOAD' }],
      expectedFinalState: { targetDriveUsableAfter: 6000, destinationDrivesUsableAfter: {} },
      rejectedAlternatives: [],
      rationale: 'Test expiration',
    };

    opRepo.insert({
      id: 'OP-EXP',
      operationType: 'UPLOAD',
      status: 'RESERVED',
      requestedBytes: 4000,
      createdAt: now,
    });

    // Acquire with negative TTL so it expires immediately
    resManager.acquirePlanReservations(plan, 'OP-EXP', -1000);

    const expired = reaper.runOnce();
    expect(expired).toBe(1);
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(0);
  });
});

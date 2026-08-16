import { OperationStatus } from '../../domain/types.js';

export interface OperationRecoveryResult {
  operationId: string;
  operationType: string;
  previousStatus: OperationStatus;
  resolution: 'ROLLED_BACK' | 'FINALIZED' | 'CANCELLED' | 'CLEANED_UP';
  details: string;
}

export interface RecoveryReport {
  recoveredCount: number;
  results: OperationRecoveryResult[];
}

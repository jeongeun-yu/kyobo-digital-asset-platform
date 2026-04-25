// Interfaces
export type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from './interfaces/ICoreBankingAdapter';

// HTTP client → internal/blockchain-gateway
export { InternalGatewayClient, InternalGatewayError } from './adapters/InternalGatewayClient';
export type {
  GatewayUserAccountResponse,
  GatewayNftHoldingRequest,
  GatewayAuditLogRequest,
  GatewayRewardNotificationRequest,
} from './adapters/InternalGatewayClient';

// Adapters
export { KyoboCoreBankingAdapter } from './adapters/KyoboCoreBankingAdapter';
export { StubCoreBankingAdapter }  from './adapters/StubCoreBankingAdapter';
export { KDEPAdapter }             from './adapters/KDEPAdapter';
export type {
  KDEPIssuancePayload,
  KDEPDividendPayload,
  KDEPDocumentPayload,
  KDEPRedemptionPayload,
} from './adapters/KDEPAdapter';

// Services
export { LedgerService }    from './ledger/LedgerService';
export { AuditLogService }  from './audit/AuditLogService';
export { ReconcileService } from './reconcile/ReconcileService';

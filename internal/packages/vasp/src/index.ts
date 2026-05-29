// ── 인터페이스 ────────────────────────────────────────────────────────────────
export type { IVASPAdapter }    from './interfaces/IVASPAdapter';

// ── VASP 어댑터 ───────────────────────────────────────────────────────────────
export { ExternalVASPAdapter }  from './external/ExternalVASPAdapter';
export { KyoboVASPAdapter }     from './internal/KyoboVASPAdapter';

// ── TX 상태머신 ───────────────────────────────────────────────────────────────
export type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus, TxTransitionEvent } from './tx/TxStateMachineService';
export { TxStateMachineService, MintRequestNotFoundError, InvalidStatusTransitionError } from './tx/TxStateMachineService';

// ── TX 하위 컴포넌트 (Phase 3) ────────────────────────────────────────────────
export { Broadcaster }          from './tx/Broadcaster';
export { ConfirmationTracker }  from './tx/ConfirmationTracker';
export type { TxAttempt, TxAttemptRepository, AttemptStatus } from './tx/TxAttempt';
export { ATTEMPT_VALID_TRANSITIONS } from './tx/TxAttempt';

// ── Nonce / Signer (Phase 3) ──────────────────────────────────────────────────
export { NonceManager }         from './nonce/NonceManager';
export type { ISignerService, SignRequest, SignResult } from './signer/ISignerService';
export { StubSignerService }    from './signer/ISignerService';

// ── Outbox (Phase 3) ──────────────────────────────────────────────────────────
export { OutboxWorker }         from './outbox/OutboxWorker';
export type { OutboxEvent, OutboxEventType, OutboxStatus } from './outbox/OutboxWorker';

// ── 키 거버넌스 ───────────────────────────────────────────────────────────────
export { KeyGovernanceService } from './governance/KeyGovernanceService';
export type { SafeTxParams, PendingTx, SignatureEntry, SignatureStatus, TravelRuleData, PendingTxStatus } from './governance/KeyGovernanceService';
export { TravelRuleRequiredError, PendingTxNotFoundError, DuplicateSignatureError } from './governance/KeyGovernanceService';
export { WhitelistAddressService } from './governance/WhitelistAddressService';

// ── 복구 ──────────────────────────────────────────────────────────────────────
export { VaspRecoveryService, InvalidStateTransitionError } from './recovery/VaspRecoveryService';
export type { RecoveryResult }  from './recovery/VaspRecoveryService';


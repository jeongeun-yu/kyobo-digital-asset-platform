export interface AuditLogParams {
  actor:        string;
  action:       string;
  resourceType: string;
  resourceId:   string;
  beforeState:  unknown | null;
  afterState:   unknown;
}

export interface IInternalLedgerClient {
  recordAuditLog(params: AuditLogParams): Promise<void>;
}

#!/usr/bin/env node
/**
 * diagram-check.js
 *
 * 소스코드 ↔ class-diagram.html 정합성 자동 검사
 *
 * 실행: node tools/diagram-check.js
 *
 * 검사 항목:
 *   [1] 소스에 있는 주요 클래스/인터페이스가 다이어그램에 정의되어 있는가
 *   [2] implements 관계가 다이어그램에 있는가  (Interface <|.. Class)
 *   [3] extends 관계가 다이어그램에 있는가     (Base <|-- Sub 또는 <|..)
 *   [4] constructor 의존성이 다이어그램에 있는가 (Owner *-- Dep 또는 o--)
 *   [5] 다이어그램에 정의됐지만 아무 관계도 없는 고아 노드
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 설정 ──────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const DIAGRAM     = path.join(ROOT, 'docs', 'class-diagram.html');
const SOURCE_DIRS = [
  'internal/apps/issuer-service/src',
  'internal/packages/chain-adapters/src',
  'internal/packages/core-banking/src',
  'internal/packages/event-engine/src',
  'internal/packages/vasp/src',
];

// 다이어그램에 포함하지 않아도 되는 클래스 (스텁·테스트·에러 클래스)
const SKIP_CLASS_PATTERNS = [
  /^InMemory/,      // 테스트용 in-memory 구현체
  /^Stub/,          // 테스트 stub
  /Error$/,         // XxxError
  /Exception$/,     // XxxException
];

// 다이어그램에 포함하지 않아도 되는 인터페이스 (순수 DTO·값 객체·설정)
// 행동(메서드)이 없고 필드만 있는 인터페이스는 생략
const SKIP_INTERFACE_PATTERNS = [
  /Params$/,        // MintParams, BurnParams 등 DTO
  /Result$/,        // ConditionResult, ReconcileResult 등 DTO
  /Request$/,       // GatewayNftHoldingRequest 등
  /Response$/,      // GatewayUserAccountResponse 등
  /Payload$/,       // KDEPIssuancePayload 등
  /Options$/,       // CircuitBreakerOptions 등
  /Config$/,        // WorkerGroupConfig, AdapterConfig 등
  /Receipt$/,       // TransactionReceipt, VASPTransactionReceipt
  /Entry$/,         // AuditEntry, SignatureEntry, WhitelistEntry
  /Event$/,         // TxTransitionEvent, ChainEvent 등 이벤트 DTO
  /^Logger$/,       /^RpcProvider$/, /^BlockchainRpc$/,
  /^NonceAllocation$/, /^OutboxEvent$/, /^SignRequest$/, /^SignResult$/,
  /^PendingTx$/, /^TxAttempt$/, /^OutboundEvent$/, /^DLQItem$/,
  /^StreamMessage$/, /^WalletInfo$/, /^WalletMapping$/, /^IssuancePolicy$/,
  /^IssuanceRequest$/, /^MintRequest$/, /^ActivityEvent$/, /^ProvisionResult$/,
  /^TransferRequest$/, /^TransferResult$/, /^RetryPolicy$/, /^RecoveryResult$/,
  /^InternalLedgerBalance$/, /^UserAccount$/, /^RewardNotification$/,
  /^BalanceSyncRequest$/, /^RetryOptions$/, /^SignatureStatus$/,
  /^BulkChunkResult$/, /^BulkJob$/,
  // Phase 3+ / VASP 내부 인터페이스
  /^BulkJobRepository$/, /^MintSubmitter$/, /^WalletMappingRepository$/,
  /^SignatureVerifier$/, /^ExternalVaspClient$/, /^AuditLogAdapter$/,
  /^IBlockchainAdapterV3$/, /^DLQRedisClient$/, /^DLQNotifier$/, /^DLQStore$/,
  /^TravelRuleData$/, /^ISignerService$/, /^TxAttemptRepository$/,
];

// 다이어그램에 없어도 되는 구체 클래스 (관계 체크도 스킵)
const SKIP_CLASSES = new Set([
  // Phase 2+/3 미구현
  'KyoboVASPAdapter', 'NonceManager', 'DbWalletResolver',
  'CouponConditionStrategy',       // Phase 2+ (index.ts 주석 처리)
  'KDEPAdapter',                   // Phase 3
  'BulkIssueService',
  // 다이어그램 범위 밖 어댑터
  'CircleAdapter', 'KRW1StablecoinAdapter', 'UTXOAdapter', 'XRPLAdapter',
  // 데코레이터 구현체 (AdapterDecorator 만 다이어그램에 존재)
  'LoggingAdapterDecorator', 'RetryAdapterDecorator',
  // VASP 내부 구현 (다이어그램 범위 밖)
  'Broadcaster', 'ConfirmationTracker', 'ExternalVaspTxClient',
  'KeyGovernanceService', 'WhitelistAddressService',
  'OutboxWorker', 'VaspRecoveryService', 'StubSignerService',
  // event-engine 내부 (ChainEventListener에 등록하는 IEventHandler 구현체들 — 현재 flow 미사용)
  'NFTBurnedHandler', 'NFTIssuedHandler', 'NFTTransferredHandler',
  'RetryHandler', 'DeadLetterQueue',
  // 서비스 내부 구현 (다이어그램 범위 밖)
  'WalletMappingService', 'WalletProvisioningService',
  'IoRedisAdapter',                // 인프라 어댑터 (다이어그램 밖)
  'InternalGatewayError',          // 에러 (패턴 매치 안 됨)
  'AuditLogService',               // 별도 패키지
  // wallet provisioning
  'PgWalletMappingRepository',
  // ChainAdapter 팩토리 (다이어그램 밖)
  'ChainAdapterFactory', 'ChainAdapterRegistry',
]);

// constructor 파라미터 중 원시·외부 타입 무시
const SKIP_TYPES = new Set([
  'Pool', 'Redis', 'string', 'number', 'boolean', 'bigint',
  'Buffer', 'Date', 'Error', 'EventEmitter', 'Server',
  'ethers', 'Wallet', 'Provider', 'Contract',
  'Logger', 'Writable', 'Readable',
  'null', 'undefined', 'never', 'void',
]);

// 다이어그램에서 고아로 취급하지 않는 노드 (외부 타입 참조로만 쓰임)
const SKIP_ORPHAN = new Set([
  'Pool', 'Redis', 'NFT_ISSUER_ADDR', 'NFT_CONTRACT_ADDR',
  'kyobo', 'events',  // 스트림 키 등
]);

// ── 소스 파일 수집 ─────────────────────────────────────────────────────────────

function collectSourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    walkDir(path.join(ROOT, dir), files);
  }
  return files;
}

function walkDir(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '__tests__'].includes(entry.name)) walkDir(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      entry.name !== 'index.ts'
    ) {
      out.push(full);
    }
  }
}

// ── 소스 파싱 ─────────────────────────────────────────────────────────────────

function shouldSkipClass(name) {
  if (SKIP_CLASSES.has(name)) return true;
  return SKIP_CLASS_PATTERNS.some(p => p.test(name));
}

function shouldSkipInterface(name) {
  return SKIP_INTERFACE_PATTERNS.some(p => p.test(name));
}

function stripGenerics(s) {
  return s.replace(/<[^>]*>/g, '').trim();
}

function parseSourceFiles(files) {
  const classes    = new Map();
  const interfaces = new Map();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    // 클래스 선언
    const classRe = /export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w<>, ]+?))?(?:\s+implements\s+([\w<>, ]+?))?\s*(?:<[^{]*>)?\s*\{/g;
    let m;
    while ((m = classRe.exec(src)) !== null) {
      const name = m[1];
      if (shouldSkipClass(name)) continue;
      const extendsRaw = m[2] ? stripGenerics(m[2].trim()) : null;
      // Error 상속은 무시
      const extendsName = extendsRaw && extendsRaw !== 'Error' ? extendsRaw : null;
      const implNames   = m[3] ? m[3].split(',').map(s => stripGenerics(s.trim())) : [];
      const ctorDeps    = extractCtorDeps(src, name);
      classes.set(name, { file: rel, extends: extendsName, implements: implNames, ctorDeps });
    }

    // 인터페이스 선언
    const ifaceRe = /export\s+interface\s+(\w+)(?:\s+extends\s+([\w<>, ]+?))?\s*\{/g;
    while ((m = ifaceRe.exec(src)) !== null) {
      const name = m[1];
      if (shouldSkipInterface(name)) continue;
      const extendsNames = m[2]
        ? m[2].split(',').map(s => stripGenerics(s.trim())).filter(s => s !== 'Error')
        : [];
      interfaces.set(name, { file: rel, extends: extendsNames });
    }
  }

  return { classes, interfaces };
}

function extractCtorDeps(src, className) {
  // 클래스 본문 추출
  const classBodyRe = new RegExp(
    `class\\s+${className}[^{]*\\{([\\s\\S]*?)^\\}`,
    'gm'
  );
  const bodyMatch = classBodyRe.exec(src);
  if (!bodyMatch) return [];

  const ctorRe  = /constructor\s*\(([^)]*)\)/;
  const ctorM   = ctorRe.exec(bodyMatch[1]);
  if (!ctorM) return [];

  const deps   = [];
  const paramRe = /(?:private|protected|public|readonly)\s+(?:readonly\s+)?(\w+)(\?)?:\s*([\w<>[\],| ]+)/g;
  let pm;
  while ((pm = paramRe.exec(ctorM[1])) !== null) {
    const isOptional = !!pm[2];
    const typePart   = pm[3].trim();
    const types      = typePart.split('|').map(t => stripGenerics(t.trim()));
    for (const t of types) {
      if (t && !SKIP_TYPES.has(t) && /^[A-Z]/.test(t)) {
        deps.push({ type: t, optional: isOptional });
      }
    }
  }
  return deps;
}

// ── 다이어그램 파싱 ───────────────────────────────────────────────────────────

function parseDiagram() {
  const html   = fs.readFileSync(DIAGRAM, 'utf8');
  const diagrams = [];
  const tmplRe   = /`(classDiagram[\s\S]*?)`/g;
  let m;
  while ((m = tmplRe.exec(html)) !== null) diagrams.push(m[1]);
  const allText = diagrams.join('\n');

  // 정의된 노드
  const defined = new Set();
  const classDefRe = /^\s*class\s+(\w+)/gm;
  while ((m = classDefRe.exec(allText)) !== null) defined.add(m[1]);

  // 관계
  const relations = [];
  const relRe = /^\s*(\w+)\s+((?:<\|\.\.)|(?:<\|--)|\*--|o--|-->|\.\.>|--)\s+(\w+)/gm;
  while ((m = relRe.exec(allText)) !== null) {
    relations.push({ from: m[1], type: m[2], to: m[3] });
  }

  // 연결된 노드
  const connected = new Set();
  for (const r of relations) { connected.add(r.from); connected.add(r.to); }

  return { defined, relations, connected };
}

// ── 관계 존재 헬퍼 ────────────────────────────────────────────────────────────

function hasRelation(relations, from, type, to) {
  // Mermaid 표기: Interface <|.. Class  →  r.from=Interface, r.to=Class
  //               Owner *-- Dep         →  r.from=Owner,     r.to=Dep
  return relations.some(r => {
    if (type === 'implements') return r.from === to   && r.to === from && r.type === '<|..';
    if (type === 'extends')    return r.from === to   && r.to === from && (r.type === '<|--' || r.type === '<|..');
    if (type === 'composes')   return r.from === from && r.to === to   && (r.type === '*--' || r.type === 'o--');
    return false;
  });
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

function main() {
  const files = collectSourceFiles();
  const { classes, interfaces } = parseSourceFiles(files);
  const { defined, relations, connected } = parseDiagram();

  const missing_class = [];
  const missing_rel   = [];
  const orphan        = [];

  // [1] 소스 클래스/인터페이스 → 다이어그램 정의 확인
  for (const [name] of classes) {
    if (!defined.has(name)) missing_class.push(`클래스 누락: ${name}`);
  }
  for (const [name] of interfaces) {
    if (!defined.has(name)) missing_class.push(`인터페이스 누락: ${name}`);
  }

  // [2] implements
  for (const [name, info] of classes) {
    for (const iface of info.implements) {
      if (!defined.has(iface)) continue; // 다이어그램 밖 인터페이스는 무시
      if (!hasRelation(relations, name, 'implements', iface))
        missing_rel.push(`구현 관계 누락: ${iface} <|.. ${name}`);
    }
  }

  // [3] extends
  for (const [name, info] of classes) {
    if (!info.extends) continue;
    if (!defined.has(info.extends)) continue;
    if (!hasRelation(relations, name, 'extends', info.extends))
      missing_rel.push(`상속 관계 누락: ${info.extends} <|-- ${name}`);
  }
  for (const [name, info] of interfaces) {
    for (const base of info.extends) {
      if (!defined.has(base)) continue;
      if (!hasRelation(relations, name, 'extends', base))
        missing_rel.push(`인터페이스 상속 누락: ${base} <|.. ${name}`);
    }
  }

  // [4] constructor 의존성
  for (const [name, info] of classes) {
    if (!defined.has(name)) continue; // 다이어그램에 없는 클래스는 관계 체크 스킵
    for (const dep of info.ctorDeps) {
      if (!defined.has(dep.type)) continue;
      if (!hasRelation(relations, name, 'composes', dep.type))
        missing_rel.push(`의존성 누락: ${name} ${dep.optional ? 'o--' : '*--'} ${dep.type}`);
    }
  }

  // [5] 고아 노드
  for (const name of defined) {
    if (SKIP_ORPHAN.has(name)) continue;
    if (!connected.has(name)) orphan.push(`고아 노드: ${name}`);
  }

  // ── 출력 ──
  const total = missing_class.length + missing_rel.length + orphan.length;

  if (total === 0) {
    console.log('\n✅ 이상 없음 — 소스와 다이어그램이 일치합니다.\n');
    return;
  }

  console.log(`\n🔍 diagram-check 결과: ${total}건\n`);

  if (missing_class.length) {
    console.log(`── ① 클래스/인터페이스 정의 누락 (${missing_class.length}건) ──`);
    missing_class.forEach(s => console.log(`  ✗ ${s}`));
  }
  if (missing_rel.length) {
    console.log(`\n── ② 관계 화살표 누락 (${missing_rel.length}건) ──`);
    missing_rel.forEach(s => console.log(`  ✗ ${s}`));
  }
  if (orphan.length) {
    console.log(`\n── ③ 고아 노드 — 정의는 있으나 연결 없음 (${orphan.length}건) ──`);
    orphan.forEach(s => console.log(`  ✗ ${s}`));
  }

  console.log(`\n총 ${total}건. 수정 후 다시 실행하세요.\n`);
}

main();

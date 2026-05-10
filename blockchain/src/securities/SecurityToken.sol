// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../base/BaseToken.sol";
import "../interfaces/ISecurityToken.sol";
import "../interfaces/IInvestorRegistry.sol";

// =============================================================================
// Phase 3 STUB — STO (Security Token Offering)
// =============================================================================
// 구현 시점: 금융위원회 토큰증권 가이드라인 정식 적용 후
//            (현행 기준: 2024년 토큰증권 발행·유통 규율체계 정비안)
//
// 설계 방향 (변경 금지):
//   - ERC-1400 (ISecurityToken 인터페이스) 기반
//   - BaseToken 상속 → RBAC / pause / compliance 구조 Phase 1과 동일
//   - compliance는 반드시 InvestorCompliance로 교체 후 배포
//   - Partition 구조: INSURANCE_CLASS_A / INSURANCE_CLASS_B
//   - IInvestorRegistry 직접 참조 → 발행 시 락업 설정
//   - ICompliance 훅 → 전송마다 투자자 등록 + 보유 한도 + 락업 검증
//   - 결제: KRWStablecoin (Phase 2) — issueByPartition() 호출 전 결제 선처리
//   - 담보 자산 참조: IOracle → 자산 가치 실시간 검증 (배당 기준)
//
// 규제 연동:
//   - 한국예탁결제원 연동 포인트: setDocument() + KDEPAdapter.notifyIssuance()
//   - 금융보안원 ISMS-P: 전 이벤트 로그 기록
//   - 컨트롤러 강제 이전: 법원 명령·AML 조치 대응
//
// 교체 절차 (Phase 1 → Phase 3 전환):
//   1. InvestorRegistry 배포
//   2. InvestorCompliance 배포 (InvestorRegistry 주소 주입)
//   3. SecurityToken 배포 (InvestorCompliance 주소 주입)
//   4. 투자자 등록 (InvestorRegistry.register)
//   5. SecurityToken.issueByPartition() 호출
// =============================================================================

contract SecurityToken is BaseToken, ISecurityToken, ReentrancyGuard {

    // ─── 파티션 상수 ─────────────────────────────────────────────────────
    bytes32 public constant PARTITION_CLASS_A = keccak256("INSURANCE_CLASS_A");
    bytes32 public constant PARTITION_CLASS_B = keccak256("INSURANCE_CLASS_B");

    // ─── 역할 ────────────────────────────────────────────────────────────
    bytes32 public constant CONTROLLER_ROLE   = keccak256("CONTROLLER_ROLE");
    bytes32 public constant REGISTRAR_ROLE    = keccak256("REGISTRAR_ROLE");

    // ─── 스토리지 ─────────────────────────────────────────────────────────
    // partition => holder => balance
    mapping(bytes32 => mapping(address => uint256)) private _partitionBalances;

    // holder => partition[]
    mapping(address => bytes32[]) private _holderPartitions;

    // 전체 파티션 목록
    bytes32[] private _allPartitions;
    mapping(bytes32 => bool) private _partitionExists;

    // 오퍼레이터 승인
    mapping(address => mapping(address => bool)) private _operators; // holder => operator => bool
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _partitionOperators;

    // 문서 (투자설명서 등)
    mapping(bytes32 => Document) private _documents;

    // InvestorRegistry 참조 (compliance와 별도 — 락업 설정용)
    IInvestorRegistry public investorRegistry;

    constructor(
        address issuer_,
        address compliance_,
        address investorRegistry_
    )
        BaseToken(issuer_, compliance_)
    {
        investorRegistry = IInvestorRegistry(investorRegistry_);
        _grantRole(CONTROLLER_ROLE, issuer_);
        _grantRole(REGISTRAR_ROLE, issuer_);

        // 기본 파티션 등록
        _registerPartition(PARTITION_CLASS_A);
        _registerPartition(PARTITION_CLASS_B);
    }

    function tokenType() external pure override returns (TokenType) {
        return TokenType.SECURITY_TOKEN;
    }

    // ─── 잔액 조회 ────────────────────────────────────────────────────────

    function balanceOfByPartition(
        bytes32 partition,
        address holder
    ) external view override returns (uint256) {
        return _partitionBalances[partition][holder];
    }

    function partitionsOf(address holder) external view override returns (bytes32[] memory) {
        return _holderPartitions[holder];
    }

    function totalPartitions() external view override returns (bytes32[] memory) {
        return _allPartitions;
    }

    // ─── 전송 가능 여부 사전 확인 ─────────────────────────────────────────

    function canTransferByPartition(
        address from,
        address to,
        bytes32 partition,
        uint256 value,
        bytes calldata /* data */
    ) external view override returns (bytes1 statusCode, bytes32 reasonCode, bytes32 partition_) {
        // Phase 3: InvestorRegistry 실제 조회
        // (bool allowed, bytes32 reason) = investorRegistry.canAcceptTransfer(to, partition, value);
        // if (!allowed) return (0x57, reason, partition);

        if (_partitionBalances[partition][from] < value) {
            return (0x52, keccak256("INSUFFICIENT_BALANCE"), partition);
        }

        return (0x51, bytes32(0), partition); // 0x51 = 성공 (ERC-1400)
    }

    // ─── 발행 ────────────────────────────────────────────────────────────

    /**
     * @notice 파티션 지정 STO 발행
     *
     * Phase 3 구현 시:
     *   1. compliance.canTransfer(address(0), holder, value) 검증
     *   2. 잔액 추가 + 홀더 파티션 목록 업데이트
     *   3. investorRegistry.setLockup(holder, partition, lockupUntil) 락업 설정
     *   4. KDEPAdapter.notifyIssuance() 예탁결제원 통보
     */
    function issueByPartition(
        bytes32        partition,
        address        holder,
        uint256        value,
        bytes calldata data
    ) external override onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant {
        require(_partitionExists[partition], "SecurityToken: unknown partition");
        _checkCompliance(address(0), holder, value);

        // Phase 3: 실제 잔액 업데이트
        // _partitionBalances[partition][holder] += value;
        // _addPartitionToHolder(holder, partition);

        emit IssuedByPartition(partition, holder, value, data);
        emit Issued(holder, value, keccak256(data));
    }

    /**
     * @notice 파티션 지정 소각 (만기 상환·회수)
     *
     * Phase 3:
     *   1. 잔액 차감
     *   2. KDEPAdapter.notifyRedemption()
     */
    function redeemByPartition(
        bytes32        partition,
        uint256        value,
        bytes calldata data
    ) external override whenNotPaused nonReentrant {
        require(_partitionBalances[partition][msg.sender] >= value, "SecurityToken: insufficient balance");

        // Phase 3: 실제 잔액 차감
        // _partitionBalances[partition][msg.sender] -= value;

        emit RedeemedByPartition(partition, msg.sender, value, data);
        emit Revoked(msg.sender, value, keccak256(data));
    }

    // ─── 전송 ────────────────────────────────────────────────────────────

    /**
     * @notice 파티션 지정 전송
     *
     * Phase 3:
     *   1. InvestorCompliance.setActivePartition(partition) 컨텍스트 설정
     *   2. compliance.canTransfer 검증
     *   3. 잔액 이동
     *   4. compliance.transferred() → 보유량 업데이트
     */
    function transferByPartition(
        bytes32        partition,
        address        to,
        uint256        value,
        bytes calldata data
    ) external override whenNotPaused nonReentrant returns (bytes32) {
        require(_partitionBalances[partition][msg.sender] >= value, "SecurityToken: insufficient balance");
        _checkCompliance(msg.sender, to, value);

        // Phase 3: 실제 잔액 이동
        // _partitionBalances[partition][msg.sender] -= value;
        // _partitionBalances[partition][to] += value;
        // compliance.transferred(msg.sender, to, value);

        emit TransferByPartition(partition, msg.sender, msg.sender, to, value, data, "");
        return partition;
    }

    function operatorTransferByPartition(
        bytes32        partition,
        address        from,
        address        to,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external override whenNotPaused nonReentrant returns (bytes32) {
        require(
            _operators[from][msg.sender] || _partitionOperators[partition][from][msg.sender],
            "SecurityToken: not authorized operator"
        );
        require(_partitionBalances[partition][from] >= value, "SecurityToken: insufficient balance");
        _checkCompliance(from, to, value);

        // Phase 3: 실제 잔액 이동

        emit TransferByPartition(partition, msg.sender, from, to, value, data, operatorData);
        return partition;
    }

    // ─── 컨트롤러 강제 이전 ───────────────────────────────────────────────

    /**
     * @notice 규제 당국 요구 시 강제 이전 — 법원 명령·AML 조치
     *         CONTROLLER_ROLE(교보생명 규정 준법 담당)만 호출 가능
     */
    function controllerTransfer(
        address        from,
        address        to,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external override onlyRole(CONTROLLER_ROLE) nonReentrant {
        // Phase 3: 파티션 지정 강제 이전

        emit ControllerTransfer(msg.sender, from, to, value, data, operatorData);
    }

    function controllerRedeem(
        address        holder,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external override onlyRole(CONTROLLER_ROLE) nonReentrant {
        // Phase 3: 강제 소각

        emit Revoked(holder, value, keccak256(abi.encodePacked(data, operatorData)));
    }

    // ─── 오퍼레이터 ───────────────────────────────────────────────────────

    function authorizeOperator(address operator) external override {
        _operators[msg.sender][operator] = true;
    }

    function revokeOperator(address operator) external override {
        _operators[msg.sender][operator] = false;
    }

    function authorizeOperatorByPartition(bytes32 partition, address operator) external override {
        _partitionOperators[partition][msg.sender][operator] = true;
    }

    function revokeOperatorByPartition(bytes32 partition, address operator) external override {
        _partitionOperators[partition][msg.sender][operator] = false;
    }

    function isOperator(address operator, address holder) external view override returns (bool) {
        return _operators[holder][operator];
    }

    function isOperatorForPartition(
        bytes32 partition,
        address operator,
        address holder
    ) external view override returns (bool) {
        return _partitionOperators[partition][holder][operator];
    }

    // ─── 문서 ─────────────────────────────────────────────────────────────

    /**
     * @notice 투자설명서·약관 온체인 연결
     *         예탁결제원 연동 포인트 — 문서 등록 후 KDEPAdapter.notifyDocumentUpdate() 호출
     */
    function setDocument(
        bytes32 name,
        string calldata uri,
        bytes32 documentHash
    ) external override onlyRole(ISSUER_ROLE) {
        _documents[name] = Document({ uri: uri, documentHash: documentHash, updatedAt: block.timestamp });
        emit DocumentUpdated(name, uri, documentHash);
    }

    function getDocument(bytes32 name) external view override returns (Document memory) {
        return _documents[name];
    }

    // ─── 내부 유틸 ────────────────────────────────────────────────────────

    function _registerPartition(bytes32 partition) internal {
        if (!_partitionExists[partition]) {
            _allPartitions.push(partition);
            _partitionExists[partition] = true;
        }
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

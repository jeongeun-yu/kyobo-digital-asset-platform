// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IOracle.sol";
import "./KyoboNFT.sol";

/**
 * @title NFTIssuer
 * @notice 오라클 데이터를 검증하고 KyoboNFT 발행을 실행하는 게이트웨이.
 *
 * 역할:
 *   사용자/백엔드 → NFTIssuer → KyoboNFT.mint() / mintBatch()
 *   KyoboNFT 직접 호출 경로를 차단 → 발행 로직 단일화
 *
 * 이벤트 설계 (M2 S5 핵심):
 *   Issued 이벤트를 여기서 emit — 프로토콜 이벤트(TransferSingle)가 아닌 비즈니스 이벤트.
 *   ChainEventListener → NFTIssuedHandler 파이프라인이 이 이벤트를 구독.
 *   reason 필드: 어떤 활동으로 발행됐는지 오프체인 추적 가능.
 *
 * Idempotency (M4 S15):
 *   requestId 기반 중복 발행 방지 — 같은 requestId 두 번 제출 시 두 번째는 revert
 *   DB UNIQUE 제약 + 컨트랙트 mapping 이중 방어
 *
 * 배치 발행 (M5):
 *   executeBulkIssue() — 500건씩 청크 분할하여 KyoboNFT.mintBatch() 호출
 *   BulkIssuerService.ts에서 이 컨트랙트 호출 시 chunk 분할 처리
 */
contract NFTIssuer is AccessControl, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    KyoboNFT public nft;
    IOracle  public oracle;

    /// @notice requestId → 발행 여부 (Idempotency key)
    mapping(bytes32 => bool) public issued;

    uint256 public constant MAX_BATCH_SIZE = 500;

    /// @notice 비즈니스 발행 이벤트 — ChainEventListener가 구독
    ///         TransferSingle(ERC-1155 프로토콜 이벤트)과 달리 reason 포함
    /// @notice 비즈니스 발행 이벤트 — ChainEventListener가 구독
    ///         TransferSingle(ERC-1155 프로토콜 이벤트)과 달리 reason 포함
    ///         reason = activityId (어떤 활동으로 발행됐는지 오프체인 추적)
    event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);

    constructor(address nft_, address oracle_) {
        nft    = KyoboNFT(nft_);
        oracle = IOracle(oracle_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    /**
     * @notice 단건 발행 — 오라클 검증 후 mint
     *
     * @param to          수령인
     * @param tokenId     KyoboNFT.encodeTokenId()로 생성한 ID
     * @param amount      발행 수량
     * @param requestId   Idempotency key (오프체인 UUID → bytes32)
     * @param oracleData  오라클 서명 데이터 (위변조 방지)
     */
    function issueNFT(
        address to,
        uint256 tokenId,
        uint256 amount,
        bytes32 requestId,
        IOracle.OracleData calldata oracleData
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[requestId], "NFTIssuer: already issued");
        require(oracle.verify(oracleData), "NFTIssuer: invalid oracle data");

        issued[requestId] = true;

        // TODO (M4 S15 실습): TX 상태머신 연동
        //   submitMintRequest() 호출 → SUBMITTED 상태 전이 → 여기서 CONFIRMED 전이
        nft.mint(to, tokenId, amount);

        emit Issued(to, tokenId, oracleData.dataType);
    }

    /**
     * @notice 활동 기반 NFT 발행 — 오라클 검증 후 tokenId 자동 계산
     *
     * issueNFT()의 활동 보상 특화 래퍼.
     *   - activityId를 bytes32 reason으로 사용 (이벤트 추적 가능)
     *   - tokenId = encodeTokenId(ACTIVITY_PRODUCT_CODE, eventCode) 자동 계산
     *   - ChainEventListener → NFTIssuedHandler 파이프라인의 직접 트리거
     *
     * M2 S5 실습: 이 함수 호출 → Issued 이벤트 → EVMAdapter → NFTIssuedHandler
     *
     * @param to         수령인 주소
     * @param tokenId    KyoboNFT.encodeTokenId()로 생성한 ID
     * @param activityId 활동 식별자 (오프체인 UUID → bytes32) — reason으로 emit
     * @param oracleData 오라클 서명 데이터 (ActivityOracle.verify() 통과 필요)
     */
    function issueActivityNFT(
        address to,
        uint256 tokenId,
        bytes32 activityId,
        IOracle.OracleData calldata oracleData
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[activityId], "NFTIssuer: activity already issued");
        require(oracle.verify(oracleData), "NFTIssuer: invalid oracle data");

        issued[activityId] = true;

        nft.mint(to, tokenId, 1);

        // 비즈니스 이벤트 emit — ChainEventListener가 여기를 구독한다
        emit Issued(to, tokenId, activityId);
    }

    /**
     * @notice 배치 발행 — 최대 MAX_BATCH_SIZE(500)건
     *
     * 500건 초과 시 BulkIssuerService.ts에서 청크 분할 후 복수 호출할 것.
     * 가스 계산: ~50K gas/건 × 500건 ≈ 25M gas (30M block limit 이내)
     *
     * @param to         수령인 배열
     * @param tokenIds   tokenId 배열
     * @param amounts    수량 배열
     * @param requestId  배치 전체 Idempotency key
     */
    function issueBatch(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts,
        bytes32 requestId
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[requestId], "NFTIssuer: batch already issued");
        require(to.length <= MAX_BATCH_SIZE, "NFTIssuer: batch too large - split in 500");
        require(
            to.length == tokenIds.length && tokenIds.length == amounts.length,
            "NFTIssuer: array length mismatch"
        );

        issued[requestId] = true;

        // TODO (M5 실습): mintBatch 가스 측정 + 500건 한도 이유 분석
        nft.mintBatch(to, tokenIds, amounts);
    }

    function updateOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracle = IOracle(newOracle);
    }

    function updateNFT(address newNFT) external onlyRole(DEFAULT_ADMIN_ROLE) {
        nft = KyoboNFT(newNFT);
    }
}

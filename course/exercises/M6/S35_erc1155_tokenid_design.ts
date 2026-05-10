/**
 * S35 실습 — ERC-1155 다중 토큰 표준과 tokenId 비트 인코딩 설계
 *
 * 강의 노트: M6_S35_erc1155_tokenid_design.md
 *
 * 실행 방법 (루트에서): npm run exercise:s35
 *
 * 목표:
 *   [1] encodeTokenId — productCode(상위 64비트) | eventCode(하위 64비트) 비트 인코딩
 *   [2] decodeTokenId — 역방향 비트 마스킹으로 원래 코드 복원
 *   [3] 다른 productCode + 같은 eventCode → 서로 다른 tokenId (충돌 없음) 확인
 *   [4] TypeScript 인코딩 결과 = Solidity encodeTokenId() 결과 동일성 검증
 *   [5] ERC-721 vs ERC-1155 가스 비용 비교
 *
 * 전제 조건:
 *   Hardhat 불필요 — 순수 TypeScript 로직 검증
 *   KyoboNFT.sol의 encodeTokenId / decodeTokenId 와 동일한 로직을 TS로 구현
 */

// ────────────────────────────────────────────────────────────────────────
// tokenId 인코딩 상수
// KyoboNFT.sol: uint8 public constant PRODUCT_CODE_SHIFT = 64;
// ────────────────────────────────────────────────────────────────────────

export const PRODUCT_CODE_SHIFT = BigInt(64);

/**
 * productCode와 eventCode를 하나의 uint256 tokenId로 인코딩한다.
 *
 * 비트 레이아웃:
 *   bit 127 ~ 64: productCode (64비트)
 *   bit  63 ~  0: eventCode   (64비트)
 *
 * Solidity 동등 코드:
 *   return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
 *
 * TODO: 아래 throw를 제거하고 올바른 비트 인코딩을 구현하세요.
 *   힌트: (productCode << PRODUCT_CODE_SHIFT) | eventCode
 */
export function encodeTokenId(productCode: bigint, eventCode: bigint): bigint {
  return undefined as never;
}

/**
 * tokenId를 (productCode, eventCode)로 역방향 디코딩한다.
 *
 * Solidity 동등 코드:
 *   productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
 *   eventCode   = uint64(tokenId);
 *
 * TODO: 아래 throw를 제거하고 올바른 비트 디코딩을 구현하세요.
 *   힌트:
 *     productCode = tokenId >> PRODUCT_CODE_SHIFT
 *     eventCode   = tokenId & BigInt('0xFFFFFFFFFFFFFFFF')  // 하위 64비트 마스킹
 */
export function decodeTokenId(tokenId: bigint): { productCode: bigint; eventCode: bigint } {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// productCode 상수 (강의 노트 기준)
// ────────────────────────────────────────────────────────────────────────

export const PRODUCT = {
  WALK_GOAL:    BigInt(0x01),  // 걷기 달성
  HEALTH_CHECK: BigInt(0x02),  // 건강검진
  COUPON:       BigInt(0x10),  // 캠페인 쿠폰
} as const;

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S35: ERC-1155 tokenId 비트 인코딩 설계 ===\n');

  // ── [1] 인코딩 기본 동작 확인 ────────────────────────────────────────
  console.log('[검증 1] encodeTokenId — 기본 동작');

  // 강의 노트 예시: 걷기 달성 이벤트 #42
  // tokenId = (0x01 << 64) | 42 = 0x0000000000000001_000000000000002A
  const walkEvent42 = encodeTokenId(PRODUCT.WALK_GOAL, BigInt(42));
  const expected42  = (BigInt(0x01) << PRODUCT_CODE_SHIFT) | BigInt(42);

  check('encodeTokenId(0x01, 42) 결과 일치', walkEvent42 === expected42);
  check('상위 64비트에 productCode=0x01 포함', (walkEvent42 >> PRODUCT_CODE_SHIFT) === BigInt(0x01));
  check('하위 64비트에 eventCode=42 포함',     (walkEvent42 & BigInt('0xFFFFFFFFFFFFFFFF')) === BigInt(42));

  // ── [2] 디코딩 — 왕복 검증 ───────────────────────────────────────────
  console.log('\n[검증 2] decodeTokenId — 왕복(round-trip) 검증');

  const cases: Array<{ productCode: bigint; eventCode: bigint; label: string }> = [
    { productCode: PRODUCT.WALK_GOAL,    eventCode: BigInt(42),    label: '걷기달성 #42' },
    { productCode: PRODUCT.HEALTH_CHECK, eventCode: BigInt(1),     label: '건강검진 #1' },
    { productCode: PRODUCT.COUPON,       eventCode: BigInt(10001), label: '캠페인쿠폰 #10001' },
    { productCode: BigInt(0xFF),         eventCode: BigInt(0),     label: '경계값: eventCode=0' },
    // uint64 최대값 경계 테스트
    { productCode: BigInt(1),            eventCode: BigInt('18446744073709551615'), label: '경계값: eventCode=uint64_MAX' },
  ];

  for (const { productCode, eventCode, label } of cases) {
    const tokenId = encodeTokenId(productCode, eventCode);
    const decoded = decodeTokenId(tokenId);
    check(
      `${label}: encode → decode 왕복 일치`,
      decoded.productCode === productCode && decoded.eventCode === eventCode,
    );
  }

  // ── [3] 충돌 없음 검증 ───────────────────────────────────────────────
  console.log('\n[검증 3] 충돌 없음 — 다른 productCode + 같은 eventCode → 다른 tokenId');

  // 잘못된 방법(곱셈)과 비교
  const eventCode = BigInt(100);
  const idWalk   = encodeTokenId(PRODUCT.WALK_GOAL,    eventCode);
  const idHealth = encodeTokenId(PRODUCT.HEALTH_CHECK, eventCode);
  const idCoupon = encodeTokenId(PRODUCT.COUPON,       eventCode);

  check('WALK_GOAL(0x01, 100) ≠ HEALTH_CHECK(0x02, 100)', idWalk !== idHealth);
  check('WALK_GOAL(0x01, 100) ≠ COUPON(0x10, 100)',        idWalk !== idCoupon);
  check('HEALTH_CHECK(0x02, 100) ≠ COUPON(0x10, 100)',     idHealth !== idCoupon);

  // 곱셈 방식의 충돌 재현 (교육용)
  // productCode * 10000 + eventCode 방식: (1 * 10000 + 10001) = 20001, (2 * 10000 + 1) = 20001 → 충돌!
  const collisionA = BigInt(1) * BigInt(10000) + BigInt(10001);
  const collisionB = BigInt(2) * BigInt(10000) + BigInt(1);
  check('곱셈 방식 충돌 재현 확인 (교육용: 충돌이 발생해야 true)', collisionA === collisionB);
  check('비트 시프트 방식은 동일 케이스에서 충돌 없음',
    encodeTokenId(BigInt(1), BigInt(10001)) !== encodeTokenId(BigInt(2), BigInt(1)),
  );

  // ── [4] TypeScript ↔ Solidity 동기화 검증 ───────────────────────────
  console.log('\n[검증 4] TypeScript ↔ Solidity 동기화 — 동일 tokenId 생성');

  // KyoboNFT.sol의 encodeTokenId(0x01, 42) 반환값과 동일해야 함
  // Solidity: (uint256(0x01) << 64) | uint256(42)
  //         = 0x0000000000000001_000000000000002A
  //         = 18446744073709551658 (십진수)
  const tsResult  = encodeTokenId(BigInt(0x01), BigInt(42));
  const solResult = BigInt('18446744073709551658');  // Solidity 실행값 고정

  check(
    `TS encodeTokenId(0x01, 42) = Solidity encodeTokenId(1, 42) = ${solResult}`,
    tsResult === solResult,
  );

  // M5 ActivityConditionStrategy에서도 동일한 계산 사용
  // const tokenId = (productCode << BigInt(64)) | BigInt(event.eventCode);
  const m5StyleResult = (BigInt(0x01) << BigInt(64)) | BigInt(42);
  check('M5 ActivityConditionStrategy 방식과 동일', tsResult === m5StyleResult);

  // ── [5] ERC-721 vs ERC-1155 가스 비용 비교 (개념 검증) ──────────────
  console.log('\n[검증 5] ERC-721 vs ERC-1155 가스 비교 (이론값)');

  const GAS = {
    ERC721_SINGLE_MINT:   80_000,
    ERC1155_SINGLE_MINT:  50_000,
    ERC1155_BATCH_500_TX: 25_000_000,
    BLOCK_GAS_LIMIT:      30_000_000,
  };

  const erc721Batch500 = GAS.ERC721_SINGLE_MINT * 500;
  check(
    `ERC-721 500건 = ${erc721Batch500.toLocaleString()} gas → block limit(${GAS.BLOCK_GAS_LIMIT.toLocaleString()}) 초과`,
    erc721Batch500 > GAS.BLOCK_GAS_LIMIT,
  );
  check(
    `ERC-1155 배치 500건 = ${GAS.ERC1155_BATCH_500_TX.toLocaleString()} gas → block limit 이내`,
    GAS.ERC1155_BATCH_500_TX < GAS.BLOCK_GAS_LIMIT,
  );
  check(
    `단건 발행 가스 절감: ERC-721 ${GAS.ERC721_SINGLE_MINT} → ERC-1155 ${GAS.ERC1155_SINGLE_MINT} (${Math.round((1 - GAS.ERC1155_SINGLE_MINT / GAS.ERC721_SINGLE_MINT) * 100)}% 절약)`,
    GAS.ERC1155_SINGLE_MINT < GAS.ERC721_SINGLE_MINT,
  );

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S35 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. tokenId = (productCode << 64) | eventCode — 비트 시프트로 충돌 없는 주소 공간');
  console.log('  2. 곱셈 방식은 eventCode >= 10000 구간에서 충돌 발생 → 비트 시프트 필수');
  console.log('  3. TypeScript BigInt와 Solidity uint256은 동일한 비트 연산 결과 생성');
  console.log('  4. M5 ActivityConditionStrategy ↔ M6 KyoboNFT.sol 인코딩 반드시 일치해야 함');
  console.log('  5. ERC-1155 mintBatch: 500건을 단일 TX로 처리 → ERC-721 방식 대비 블록 한도 내 처리 가능');
})();

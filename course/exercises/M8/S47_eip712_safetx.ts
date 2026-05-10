/**
 * S47 실습 — EIP-712 SafeTx 해시 수동 계산과 오프체인 서명 검증
 *
 * 강의 노트: M8_S47_eip712_safetx.md
 *
 * 실행 방법 (루트에서): npm run exercise:s47
 *
 * 목표:
 *   [1] EIP-712 domainSeparator 수동 계산 (chainId + verifyingContract)
 *   [2] SafeTx structHash 계산 — pause() 호출 시나리오
 *   [3] 최종 safeTxHash = keccak256(0x1901 + domainSeparator + structHash)
 *   [4] 개인키로 safeTxHash 서명 → ecrecover로 서명자 주소 복원
 *   [5] 잘못된 해시 서명 시 ecrecover 결과가 달라짐 (서명 위조 감지)
 *   [6] 재생 공격: 다른 chainId에서 동일 서명 재사용 불가 확인
 */

import { ethers } from 'ethers';

// ─── EIP-712 상수 ─────────────────────────────────────────────────────────────

// SafeTx 타입 해시 (Gnosis Safe 표준)
export const SAFE_TX_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,' +
    'uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,' +
    'address gasToken,address refundReceiver,uint256 nonce)',
  ),
);

export const DOMAIN_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)'),
);

// 테스트 파라미터
export const SAFE_ADDRESS  = '0x1234567890123456789012345678901234567890';
export const CHAIN_ID      = 31337; // hardhat local
export const KYOBO_NFT     = '0xKyoboNFTContractAddress0000000000000000';

// ─── EIP-712 계산 함수 ────────────────────────────────────────────────────────

/**
 * TODO [1]: domainSeparator 계산
 * keccak256(DOMAIN_TYPEHASH + chainId + verifyingContract)
 *
 * 힌트:
 *   - ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'address'], [...])
 *   - ethers.keccak256(encodedData)
 */
export function calcDomainSeparator(chainId: number, safeAddress: string): string {
  throw new Error('TODO: 구현하세요');
}

export interface SafeTxFields {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  safeTxGas?: bigint;
  baseGas?: bigint;
  gasPrice?: bigint;
  gasToken?: string;
  refundReceiver?: string;
  nonce?: bigint;
}

/**
 * TODO [2]: structHash 계산
 * keccak256(abi.encode(SAFE_TX_TYPEHASH, to, value, keccak256(data), operation, ...))
 * 주의: bytes 타입은 keccak256으로 먼저 해시한다
 *
 * 힌트:
 *   - const dataHash = ethers.keccak256(tx.data)
 *   - 인코딩 타입 배열: ['bytes32','address','uint256','bytes32','uint8',
 *                       'uint256','uint256','uint256','address','address','uint256']
 *   - 기본값: safeTxGas=0n, baseGas=0n, gasPrice=0n,
 *             gasToken=ethers.ZeroAddress, refundReceiver=ethers.ZeroAddress, nonce=0n
 */
export function calcStructHash(tx: SafeTxFields): string {
  throw new Error('TODO: 구현하세요');
}

/**
 * TODO [3]: 최종 SafeTx 해시 계산
 * keccak256(0x1901 + domainSeparator + structHash)
 *
 * 힌트:
 *   - ethers.concat(['0x1901', domainSeparator, structHash])
 *   - ethers.keccak256(concatenated)
 */
export function calcSafeTxHash(domainSeparator: string, structHash: string): string {
  throw new Error('TODO: 구현하세요');
}

// ─── 서명 유틸리티 ────────────────────────────────────────────────────────────

/**
 * TODO [4]: 개인키로 EIP-712 해시에 서명
 * (eth_signTypedData 대신 직접 ECDSA 서명 — 동일한 결과)
 *
 * 힌트:
 *   - const sig = wallet.signingKey.sign(hash)
 *   - ethers.Signature.from(sig).serialized 반환
 */
export function signEip712Hash(wallet: ethers.Wallet, hash: string): string {
  throw new Error('TODO: 구현하세요');
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S47: EIP-712 SafeTx 해시 수동 계산과 오프체인 서명 검증 ===\n');

  // ── [1] domainSeparator 계산 ───────────────────────────────────────────
  console.log('[검증 1] domainSeparator 계산 (chainId + verifyingContract)');

  const domainSep = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
  check('domainSeparator: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(domainSep));
  console.log(`  domainSeparator: ${domainSep}`);

  // 같은 파라미터 → 같은 값 (결정론적)
  const domainSep2 = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
  check('동일 파라미터 → 동일 domainSeparator (결정론적)', domainSep === domainSep2);

  // ── [2] structHash 계산 — pause() 호출 ───────────────────────────────
  console.log('\n[검증 2] structHash 계산 — KyoboNFT.pause() 호출 SafeTx');

  const pauseTx: SafeTxFields = {
    to:        KYOBO_NFT,
    value:     0n,
    data:      '0x8456cb59', // pause() function selector
    operation: 0,            // CALL
    nonce:     0n,
  };

  const structHash = calcStructHash(pauseTx);
  check('structHash: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(structHash));
  console.log(`  structHash: ${structHash}`);

  // data가 달라지면 structHash가 달라짐 (bytes 필드 해시 보장)
  const unpauseTx: SafeTxFields = { ...pauseTx, data: '0x3f4ba83a' }; // unpause()
  const structHashUnpause = calcStructHash(unpauseTx);
  check('data 다르면 structHash 다름 (bytes 해시)', structHash !== structHashUnpause);

  // ── [3] 최종 safeTxHash 계산 ─────────────────────────────────────────
  console.log('\n[검증 3] 최종 safeTxHash = keccak256(0x1901 + domainSeparator + structHash)');

  const safeTxHash = calcSafeTxHash(domainSep, structHash);
  check('safeTxHash: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(safeTxHash));
  console.log(`  safeTxHash: ${safeTxHash}`);

  // 멱등성: 동일 파라미터 → 동일 최종 해시
  const safeTxHash2 = calcSafeTxHash(domainSep, structHash);
  check('동일 파라미터 → 동일 safeTxHash (결정론적)', safeTxHash === safeTxHash2);

  // ── [4] 서명 + ecrecover — 서명자 주소 복원 ──────────────────────────
  console.log('\n[검증 4] 개인키 서명 → ecrecover로 서명자 주소 복원');

  const signerWallet = ethers.Wallet.createRandom();
  const signature = signEip712Hash(signerWallet, safeTxHash);

  check('서명값: 65바이트 hex (r+s+v)', /^0x[0-9a-f]{130}$/.test(signature));
  console.log(`  서명자 주소: ${signerWallet.address}`);
  console.log(`  서명값(앞 20자): ${signature.slice(0, 22)}...`);

  const recovered = ethers.recoverAddress(safeTxHash, signature);
  check('ecrecover → 서명자 주소 일치', recovered.toLowerCase() === signerWallet.address.toLowerCase());

  // ── [5] 잘못된 해시 서명 → ecrecover 결과 다름 ───────────────────────
  console.log('\n[검증 5] 잘못된 해시로 ecrecover → 다른 주소 반환 (서명 위조 감지)');

  const wrongHash = calcSafeTxHash(domainSep, structHashUnpause); // 다른 TX 해시
  const recoveredFromWrong = ethers.recoverAddress(wrongHash, signature);

  check(
    'wrong hash ecrecover → 서명자 주소와 다름',
    recoveredFromWrong.toLowerCase() !== signerWallet.address.toLowerCase(),
  );
  console.log(`  wrong hash ecrecover: ${recoveredFromWrong} (다른 주소)`);

  // 빈 서명이나 조작된 서명도 다른 주소 복원
  const tamperedSig = '0x' + 'ff'.repeat(65);
  try {
    const recoveredTampered = ethers.recoverAddress(safeTxHash, tamperedSig);
    check(
      '조작된 서명 ecrecover → 서명자와 다름',
      recoveredTampered.toLowerCase() !== signerWallet.address.toLowerCase(),
    );
  } catch {
    check('조작된 서명 ecrecover → 에러 (서명 형식 불일치)', true);
  }

  // ── [6] 재생 공격 방지 — 다른 chainId에서 동일 서명 재사용 불가 ─────
  console.log('\n[검증 6] 재생 공격 방지 — chainId 변경 시 domainSeparator 달라짐');

  const mainnetDomain  = calcDomainSeparator(1,     SAFE_ADDRESS); // mainnet
  const testnetDomain  = calcDomainSeparator(31337, SAFE_ADDRESS); // hardhat

  check('mainnet vs testnet domainSeparator 다름', mainnetDomain !== testnetDomain);
  console.log(`  mainnet  domainSeparator: ${mainnetDomain}`);
  console.log(`  testnet  domainSeparator: ${testnetDomain}`);

  // mainnet에서 서명한 것 → testnet safeTxHash로 ecrecover
  const mainnetSafeTxHash = calcSafeTxHash(mainnetDomain, structHash);
  const testnetSafeTxHash = calcSafeTxHash(testnetDomain, structHash);
  check('mainnet vs testnet safeTxHash 다름', mainnetSafeTxHash !== testnetSafeTxHash);

  // mainnet에서 만든 서명을 testnet 해시에 ecrecover → 다른 주소
  const mainnetSig = signEip712Hash(signerWallet, mainnetSafeTxHash);
  const recoveredOnTestnet = ethers.recoverAddress(testnetSafeTxHash, mainnetSig);
  check(
    'mainnet 서명을 testnet 해시에 ecrecover → 서명자와 다름 (재생 공격 차단)',
    recoveredOnTestnet.toLowerCase() !== signerWallet.address.toLowerCase(),
  );

  // 서로 다른 Safe 주소도 재생 공격 차단
  const otherSafe        = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const otherSafeDomain  = calcDomainSeparator(CHAIN_ID, otherSafe);
  check('같은 체인, 다른 Safe → domainSeparator 다름', otherSafeDomain !== testnetDomain);

  // ── SafeTx 4단계 흐름 간단 시뮬레이션 ─────────────────────────────────
  console.log('\n[보너스] SafeTx 생명주기 4단계 시뮬레이션');

  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();

  // [1단계] proposeTx: 해시 계산
  const proposedHash = calcSafeTxHash(testnetDomain, structHash);
  console.log('  [1단계] proposeTx: safeTxHash 계산 완료');
  check('제안 해시: 32바이트', /^0x[0-9a-f]{64}$/.test(proposedHash));

  // [2단계] addSignature: A 서명
  const sigA = signEip712Hash(walletA, proposedHash);
  const recA  = ethers.recoverAddress(proposedHash, sigA);
  check('  [2단계] A 서명 → ecrecover 일치', recA.toLowerCase() === walletA.address.toLowerCase());

  // [2단계] addSignature: B 서명
  const sigB = signEip712Hash(walletB, proposedHash);
  const recB  = ethers.recoverAddress(proposedHash, sigB);
  check('  [2단계] B 서명 → ecrecover 일치', recB.toLowerCase() === walletB.address.toLowerCase());

  console.log('  [3단계] execTransaction: 서명 2개 수집 → threshold=2 충족');
  console.log('  [4단계] EXECUTED: 온체인 TX 해시 기록 완료');
  check('2-of-2 서명 모두 ecrecover 검증 통과', true);

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S47 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. domainSeparator = keccak256(DOMAIN_TYPEHASH + chainId + safeAddress)');
  console.log('     → chainId·Safe 주소가 다르면 다른 값 → 재생 공격 원천 차단');
  console.log('  2. structHash: bytes 타입 필드는 keccak256으로 먼저 해시 (ABI 인코딩 규칙)');
  console.log('  3. safeTxHash = keccak256(0x1901 + domainSeparator + structHash) — EIP-712 표준');
  console.log('  4. 오프체인 서명: 가스비 0 → 마지막 execTransaction 1회만 가스 소모');
  console.log('  5. ecrecover: 해시가 1비트라도 다르면 복원 주소가 완전히 달라짐 → 위조 즉시 감지');
})();

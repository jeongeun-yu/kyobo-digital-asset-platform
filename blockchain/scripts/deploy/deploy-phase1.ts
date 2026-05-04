/**
 * Phase 1 배포 스크립트 — ActivityOracle + PermissiveCompliance
 *
 * M2 S8 실습 — Sepolia 배포 순서:
 *   1. ActivityOracle
 *   2. PermissiveCompliance (Phase 1 최소 컴플라이언스)
 *   3. KyoboNFT — UUPS Proxy 배포 (upgrades.deployProxy)
 *   4. NFTIssuer
 *   5. NFTIssuer에 MINTER_ROLE 부여
 *
 * UUPS 배포 방식 (S6 핵심):
 *   - upgrades.deployProxy() → 구현체 + ERC1967Proxy 자동 생성
 *   - 반환값: 프록시 주소 (이것이 실제 사용 주소)
 *   - 구현체 주소는 내부 슬롯에 저장됨
 *
 * 요구사항:
 *   npm install --save-dev @openzeppelin/hardhat-upgrades
 *   hardhat.config.ts에 '@openzeppelin/hardhat-upgrades' 플러그인 추가
 *
 * 배포 후 .env에 기록 필수:
 *   KYOBO_NFT_PROXY_ADDR=0x...   ← 프록시 주소
 *   NFT_ISSUER_ADDR=0x...
 *   ORACLE_ADDR=0x...
 */

import { ethers, upgrades } from 'hardhat';

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error('No signer configured');
  console.log('Deploying with:', deployer.address);

  // 1. ActivityOracle
  const Oracle = await ethers.getContractFactory('ActivityOracle');
  const oracle = await Oracle.deploy(
    process.env.ORACLE_SIGNER_ADDRESS ?? deployer.address,
  );
  await oracle.waitForDeployment();
  console.log('ActivityOracle:', await oracle.getAddress());

  // 2. PermissiveCompliance
  const Compliance = await ethers.getContractFactory('PermissiveCompliance');
  const compliance = await Compliance.deploy();
  await compliance.waitForDeployment();
  console.log('PermissiveCompliance:', await compliance.getAddress());

  // 3. KyoboNFT — UUPS Proxy 배포
  //
  //    upgrades.deployProxy():
  //      - 구현체 컨트랙트 배포
  //      - ERC1967Proxy 배포 + initialize(deployer.address) 호출
  //      - 반환값: 프록시 인스턴스 (주소 = 프록시 주소)
  //
  //    Storage layout 검증:
  //      UUPS 배포 시 자동으로 storage layout을 .openzeppelin/ 에 기록
  //      → 이후 upgradeProxy() 시 layout 충돌 자동 감지
  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
  const nft = await upgrades.deployProxy(
    KyoboNFT,
    [deployer.address],          // initialize(admin) 인자
    { kind: 'uups', initializer: 'initialize' },
  );
  await nft.waitForDeployment();
  const nftProxyAddr = await nft.getAddress();
  console.log('KyoboNFT (proxy):', nftProxyAddr);

  // 4. NFTIssuer
  const Issuer = await ethers.getContractFactory('NFTIssuer');
  const issuer = await Issuer.deploy(
    nftProxyAddr,
    await oracle.getAddress(),
  );
  await issuer.waitForDeployment();
  const issuerAddr = await issuer.getAddress();
  console.log('NFTIssuer:', issuerAddr);

  // 5. KyoboNFT에 NFTIssuer MINTER_ROLE 부여
  //    MINTER_ROLE = keccak256("MINTER_ROLE") — ERC-1155 기준
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
  await (nft as unknown as { grantRole(role: string, addr: string): Promise<unknown> }).grantRole(MINTER_ROLE, issuerAddr);
  console.log('MINTER_ROLE granted to NFTIssuer');

  console.log('\n── 배포 완료 ────────────────────────────────────────');
  console.log(`KYOBO_NFT_PROXY_ADDR=${nftProxyAddr}`);
  console.log(`NFT_ISSUER_ADDR=${issuerAddr}`);
  console.log(`ORACLE_ADDR=${await oracle.getAddress()}`);
  console.log(`PERMISSIVE_COMPLIANCE_ADDR=${await compliance.getAddress()}`);
  console.log('\n→ .env에 위 주소 기록 후 issuer-service 재시작');
  console.log('→ .openzeppelin/sepolia.json 에 storage layout 기록됨');

  // M3 S11 업그레이드 예고:
  // yarn hardhat run scripts/deploy/upgrade-kyobo-nft.ts --network sepolia
  //   upgrades.upgradeProxy(KYOBO_NFT_PROXY_ADDR, KyoboNFTV2)
  //   → storage layout 충돌 자동 감지 + 구현체만 교체
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

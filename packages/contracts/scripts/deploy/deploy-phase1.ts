/**
 * Phase 1 배포 스크립트
 *
 * 배포 순서:
 *   1. ActivityOracle (오라클 서명 키 설정)
 *   2. PermissiveCompliance (Phase 1 — 모두 허용)
 *   3. KyoboNFT (컴플라이언스 주소 주입)
 *   4. NFTIssuer (NFT + 오라클 주소 주입)
 *   5. KyoboNFT.grantRole(ISSUER_ROLE, NFTIssuer.address)
 *
 * 배포 후 .env에 컨트랙트 주소 기록 필수 (issuer-service에서 참조)
 */

import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  // 1. ActivityOracle
  const Oracle = await ethers.getContractFactory('ActivityOracle');
  const oracle = await Oracle.deploy(
    process.env.ORACLE_SIGNER_ADDRESS ?? deployer.address,
  );
  await oracle.waitForDeployment();
  console.log('ActivityOracle:', await oracle.getAddress());

  // 2. PermissiveCompliance (Phase 1 최소 컴플라이언스)
  // TODO: PermissiveCompliance 컨트랙트 작성 후 배포
  const complianceAddr = ethers.ZeroAddress;  // Phase 1 임시

  // 3. KyoboNFT
  const NFT = await ethers.getContractFactory('KyoboNFT');
  const nft = await NFT.deploy(deployer.address, complianceAddr);
  await nft.waitForDeployment();
  console.log('KyoboNFT:', await nft.getAddress());

  // 4. NFTIssuer
  const Issuer = await ethers.getContractFactory('NFTIssuer');
  const issuer = await Issuer.deploy(
    await nft.getAddress(),
    await oracle.getAddress(),
    process.env.BASE_METADATA_URI ?? 'https://meta.kyobo-da.internal/nft',
  );
  await issuer.waitForDeployment();
  console.log('NFTIssuer:', await issuer.getAddress());

  // 5. KyoboNFT에 NFTIssuer ISSUER_ROLE 부여
  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ISSUER_ROLE'));
  await nft.grantRole(ISSUER_ROLE, await issuer.getAddress());
  console.log('ISSUER_ROLE granted to NFTIssuer');

  console.log('\n── 배포 완료 ──────────────────────────────────');
  console.log(`NFT_CONTRACT_ADDR=${await nft.getAddress()}`);
  console.log(`NFT_ISSUER_ADDR=${await issuer.getAddress()}`);
  console.log(`ORACLE_ADDR=${await oracle.getAddress()}`);
  console.log('→ .env에 위 주소 기록 후 issuer-service 재시작');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

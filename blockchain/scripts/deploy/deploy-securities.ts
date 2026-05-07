/**
 * Phase 3 배포 스크립트 — STO (Security Token Offering)
 *
 * 배포 순서 (순서 엄수 — 의존성 역방향으로 배포):
 *   1. InvestorRegistry  (독립 컨트랙트)
 *   2. InvestorCompliance (InvestorRegistry 주소 주입)
 *   3. SecurityToken     (issuer, InvestorCompliance, InvestorRegistry 주소 주입)
 *   4. SecurityToken.grantRole(CONTROLLER_ROLE, 준법담당자 주소)
 *   5. SecurityToken.grantRole(REGISTRAR_ROLE, 발행 담당 서비스 주소)
 *   6. (선택) KRWStablecoin 배포 — Phase 2 병행 시
 *
 * 배포 전 필수 확인:
 *   - 금융위 토큰증권 가이드라인 정식 적용 완료 여부
 *   - InvestorRegistry: 투자자 등록 주체(REGISTRAR_ROLE) 결정
 *   - 담보 계좌 수탁 계약 체결 (Phase 2 병행 시)
 *
 * 배포 후 필수 작업:
 *   - 투자자 등록: InvestorRegistry.register(addr, InvestorType)
 *   - 파티션 한도 설정: InvestorRegistry.setPartitionLimit(addr, partition, maxHolding)
 *   - 투자설명서 등록: SecurityToken.setDocument(name, uri, hash)
 *   - KDEP 통보: KDEPAdapter.notifyIssuance()
 */

import { ethers } from 'hardhat';

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error('No signer configured');
  console.log('Deploying Phase 3 STO with:', deployer.address);

  // Phase 3 배포 전 가이드라인 확인 체크포인트
  if (process.env.PHASE3_REGULATORY_APPROVED !== 'true') {
    throw new Error(
      'Phase 3 배포 차단: 환경변수 PHASE3_REGULATORY_APPROVED=true 설정 필요\n' +
      '→ 금융위원회 토큰증권 가이드라인 정식 적용 확인 후 설정',
    );
  }

  // 1. InvestorRegistry
  const Registry = await ethers.getContractFactory('InvestorRegistry');
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  console.log('InvestorRegistry:', await registry.getAddress());

  // 2. InvestorCompliance
  const Compliance = await ethers.getContractFactory('InvestorCompliance');
  const compliance = await Compliance.deploy(await registry.getAddress());
  await compliance.waitForDeployment();
  console.log('InvestorCompliance:', await compliance.getAddress());

  // 3. SecurityToken
  const Token = await ethers.getContractFactory('SecurityToken');
  const token = await Token.deploy(
    deployer.address,                  // issuer (교보생명 발행 주체)
    await compliance.getAddress(),     // compliance
    await registry.getAddress(),       // investorRegistry
  );
  await token.waitForDeployment();
  console.log('SecurityToken:', await token.getAddress());

  // 4. CONTROLLER_ROLE 부여 — 규제 기관 요구 시 강제 이전 권한 (준법 담당)
  const CONTROLLER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('CONTROLLER_ROLE'));
  const controllerAddr = process.env.CONTROLLER_ADDRESS ?? deployer.address;
  await (token as unknown as { grantRole(role: string, addr: string): Promise<unknown> }).grantRole(CONTROLLER_ROLE, controllerAddr);
  console.log('CONTROLLER_ROLE granted to:', controllerAddr);

  // 5. REGISTRAR_ROLE 부여 — issuer-service 서비스 계정
  const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes('REGISTRAR_ROLE'));
  const registrarAddr = process.env.REGISTRAR_ADDRESS ?? deployer.address;
  await (registry as unknown as { grantRole(role: string, addr: string): Promise<unknown> }).grantRole(REGISTRAR_ROLE, registrarAddr);
  console.log('REGISTRAR_ROLE granted to:', registrarAddr);

  console.log('\n── Phase 3 배포 완료 ──────────────────────────────');
  console.log(`SECURITY_TOKEN_ADDR=${await token.getAddress()}`);
  console.log(`INVESTOR_REGISTRY_ADDR=${await registry.getAddress()}`);
  console.log(`INVESTOR_COMPLIANCE_ADDR=${await compliance.getAddress()}`);
  console.log('\n다음 단계:');
  console.log('  1. InvestorRegistry.register() — 투자자 등록');
  console.log('  2. SecurityToken.setDocument()  — 투자설명서 등록');
  console.log('  3. SecurityToken.issueByPartition() — STO 발행');
  console.log('  4. KDEPAdapter.notifyIssuance()  — 예탁결제원 통보');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

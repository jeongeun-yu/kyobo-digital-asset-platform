/**
 * SecurityToken 테스트 — Phase 3 STO 스텁
 *
 * 주의: 잔액 업데이트(issueByPartition 내 TODO)는 Phase 3 미구현.
 *       현재 테스트 가능한 항목: 역할·파티션 초기화, 이벤트 emit, canTransferByPartition, pause.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SecurityToken, PermissiveCompliance, MockInvestorRegistry } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('SecurityToken (Phase 3 STO)', () => {
  let token: SecurityToken;
  let compliance: PermissiveCompliance;
  let registry: MockInvestorRegistry;
  let issuer: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let PARTITION_CLASS_A: string;
  let PARTITION_CLASS_B: string;

  beforeEach(async () => {
    [issuer, holder, stranger] = await ethers.getSigners();

    const CompFactory = await ethers.getContractFactory('PermissiveCompliance');
    compliance = await CompFactory.deploy();
    await compliance.waitForDeployment();

    const RegFactory = await ethers.getContractFactory('MockInvestorRegistry');
    registry = await RegFactory.deploy();
    await registry.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory('SecurityToken');
    token = await TokenFactory.deploy(
      issuer.address,
      await compliance.getAddress(),
      await registry.getAddress(),
    );
    await token.waitForDeployment();

    PARTITION_CLASS_A = await token.PARTITION_CLASS_A();
    PARTITION_CLASS_B = await token.PARTITION_CLASS_B();
  });

  // ── 배포 ────────────────────────────────────────────────────────────────

  describe('배포', () => {
    it('issuer에게 ISSUER_ROLE / CONTROLLER_ROLE / REGISTRAR_ROLE 부여', async () => {
      const [ISSUER, CONTROLLER, REGISTRAR] = await Promise.all([
        token.ISSUER_ROLE(), token.CONTROLLER_ROLE(), token.REGISTRAR_ROLE(),
      ]);
      expect(await token.hasRole(ISSUER,     issuer.address)).to.be.true;
      expect(await token.hasRole(CONTROLLER, issuer.address)).to.be.true;
      expect(await token.hasRole(REGISTRAR,  issuer.address)).to.be.true;
    });

    it('compliance 주소 설정 확인', async () => {
      expect(await token.compliance()).to.equal(await compliance.getAddress());
    });

    it('pause 상태 false로 시작', async () => {
      expect(await token.paused()).to.be.false;
    });
  });

  // ── 파티션 초기화 ─────────────────────────────────────────────────────

  describe('파티션 초기화', () => {
    it('totalPartitions — CLASS_A / CLASS_B 2개 반환', async () => {
      const partitions = await token.totalPartitions();
      expect(partitions).to.include(PARTITION_CLASS_A);
      expect(partitions).to.include(PARTITION_CLASS_B);
      expect(partitions.length).to.equal(2);
    });

    it('신규 holder의 파티션 목록 비어 있음', async () => {
      const partitions = await token.partitionsOf(holder.address);
      expect(partitions.length).to.equal(0);
    });
  });

  // ── issueByPartition ────────────────────────────────────────────────────

  describe('issueByPartition', () => {
    it('ISSUER_ROLE 보유자 발행 → IssuedByPartition 이벤트 emit', async () => {
      await expect(
        token.connect(issuer).issueByPartition(PARTITION_CLASS_A, holder.address, 1000n, '0x'),
      ).to.emit(token, 'IssuedByPartition')
        .withArgs(PARTITION_CLASS_A, holder.address, 1000n, '0x');
    });

    it('ISSUER_ROLE 없는 계정 발행 시 revert', async () => {
      await expect(
        token.connect(stranger).issueByPartition(PARTITION_CLASS_A, holder.address, 1000n, '0x'),
      ).to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount');
    });

    it('존재하지 않는 파티션 발행 시 revert', async () => {
      const unknownPartition = ethers.id('UNKNOWN_PARTITION');
      await expect(
        token.connect(issuer).issueByPartition(unknownPartition, holder.address, 1000n, '0x'),
      ).to.be.revertedWith('SecurityToken: unknown partition');
    });
  });

  // ── canTransferByPartition ───────────────────────────────────────────────

  describe('canTransferByPartition', () => {
    it('잔액 부족 시 0x52 (INSUFFICIENT_BALANCE) 반환', async () => {
      const [statusCode] = await token.canTransferByPartition(
        holder.address, stranger.address, PARTITION_CLASS_A, 100n, '0x',
      );
      expect(statusCode).to.equal('0x52');
    });
  });

  // ── Pause ────────────────────────────────────────────────────────────────

  describe('Pause', () => {
    it('PAUSER_ROLE 보유자 pause 성공', async () => {
      await token.connect(issuer).pause();
      expect(await token.paused()).to.be.true;
    });

    it('pause 상태에서 issueByPartition revert', async () => {
      await token.connect(issuer).pause();
      await expect(
        token.connect(issuer).issueByPartition(PARTITION_CLASS_A, holder.address, 1000n, '0x'),
      ).to.be.revertedWithCustomError(token, 'EnforcedPause');
    });

    it('unpause 후 정상 동작 재개', async () => {
      await token.connect(issuer).pause();
      await token.connect(issuer).unpause();
      await expect(
        token.connect(issuer).issueByPartition(PARTITION_CLASS_A, holder.address, 1000n, '0x'),
      ).to.emit(token, 'IssuedByPartition');
    });

    it('PAUSER_ROLE 없는 계정 pause 시 revert', async () => {
      await expect(token.connect(stranger).pause())
        .to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount');
    });
  });
});

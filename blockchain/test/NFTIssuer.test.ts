/**
 * NFTIssuer 테스트 — KyoboNFT 발행 게이트웨이
 */

import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { KyoboNFT, NFTIssuer, ActivityOracle } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

async function makeOracleData(
  signer: HardhatEthersSigner,
  dataType: string,
  value: bigint,
  timestamp: bigint,
) {
  const dataTypeBytes = ethers.encodeBytes32String(dataType);
  const hash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataTypeBytes, value, timestamp],
  );
  const signature = await signer.signMessage(ethers.getBytes(hash));
  return { dataType: dataTypeBytes, value, timestamp, signature };
}

describe('NFTIssuer', () => {
  let nft: KyoboNFT;
  let issuer: NFTIssuer;
  let oracle: ActivityOracle;
  let admin: HardhatEthersSigner;
  let oracleSigner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async () => {
    [admin, oracleSigner, operator, user, stranger] = await ethers.getSigners();

    // KyoboNFT 배포
    const NFTFactory = await ethers.getContractFactory('KyoboNFT');
    nft = (await upgrades.deployProxy(NFTFactory, [admin.address], { kind: 'uups' })) as unknown as KyoboNFT;
    await nft.waitForDeployment();

    // ActivityOracle 배포
    const OracleFactory = await ethers.getContractFactory('ActivityOracle');
    oracle = await OracleFactory.deploy(oracleSigner.address);
    await oracle.waitForDeployment();

    // NFTIssuer 배포
    const IssuerFactory = await ethers.getContractFactory('NFTIssuer');
    issuer = await IssuerFactory.deploy(await nft.getAddress(), await oracle.getAddress());
    await issuer.waitForDeployment();

    // NFTIssuer에게 MINTER_ROLE 부여
    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).grantRole(MINTER_ROLE, await issuer.getAddress());

    // operator에게 OPERATOR_ROLE 부여
    const OPERATOR_ROLE = await issuer.OPERATOR_ROLE();
    await issuer.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
  });

  // ── 배포 ────────────────────────────────────────────────────────────────

  describe('배포', () => {
    it('nft / oracle 주소 설정 확인', async () => {
      expect(await issuer.nft()).to.equal(await nft.getAddress());
      expect(await issuer.oracle()).to.equal(await oracle.getAddress());
    });

    it('deployer에게 DEFAULT_ADMIN_ROLE + OPERATOR_ROLE 부여', async () => {
      const [ADMIN, OPERATOR] = await Promise.all([
        issuer.DEFAULT_ADMIN_ROLE(), issuer.OPERATOR_ROLE(),
      ]);
      expect(await issuer.hasRole(ADMIN,    admin.address)).to.be.true;
      expect(await issuer.hasRole(OPERATOR, admin.address)).to.be.true;
    });
  });

  // ── issueNFT ────────────────────────────────────────────────────────────

  describe('issueNFT', () => {
    it('유효한 오라클 서명으로 발행 성공 → Issued 이벤트 emit', async () => {
      const tokenId = await nft.encodeTokenId(1n, 1n);
      const requestId = ethers.id('req-001');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const oracleData = await makeOracleData(oracleSigner, 'ACTIVITY', 1n, timestamp);

      await expect(
        issuer.connect(operator).issueNFT(user.address, tokenId, 1, requestId, oracleData),
      ).to.emit(issuer, 'Issued').withArgs(user.address, tokenId, oracleData.dataType);

      expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });

    it('잘못된 오라클 서명 → revert', async () => {
      const tokenId = await nft.encodeTokenId(1n, 2n);
      const requestId = ethers.id('req-002');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      // stranger가 서명 — trustedSigner 아님
      const oracleData = await makeOracleData(stranger, 'ACTIVITY', 1n, timestamp);

      await expect(
        issuer.connect(operator).issueNFT(user.address, tokenId, 1, requestId, oracleData),
      ).to.be.revertedWith('NFTIssuer: invalid oracle data');
    });

    it('OPERATOR_ROLE 없는 계정 호출 시 revert', async () => {
      const tokenId = await nft.encodeTokenId(1n, 3n);
      const requestId = ethers.id('req-003');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const oracleData = await makeOracleData(oracleSigner, 'ACTIVITY', 1n, timestamp);

      await expect(
        issuer.connect(stranger).issueNFT(user.address, tokenId, 1, requestId, oracleData),
      ).to.be.revertedWithCustomError(issuer, 'AccessControlUnauthorizedAccount');
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  describe('Idempotency (requestId 중복 방지)', () => {
    it('같은 requestId 두 번 제출 시 두 번째 revert', async () => {
      const tokenId = await nft.encodeTokenId(1n, 10n);
      const requestId = ethers.id('req-dup');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const oracleData = await makeOracleData(oracleSigner, 'ACTIVITY', 1n, timestamp);

      await issuer.connect(operator).issueNFT(user.address, tokenId, 1, requestId, oracleData);

      await expect(
        issuer.connect(operator).issueNFT(user.address, tokenId, 1, requestId, oracleData),
      ).to.be.revertedWith('NFTIssuer: already issued');
    });

    it('발행 후 issued[requestId] = true', async () => {
      const tokenId = await nft.encodeTokenId(1n, 11n);
      const requestId = ethers.id('req-check');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const oracleData = await makeOracleData(oracleSigner, 'ACTIVITY', 1n, timestamp);

      expect(await issuer.issued(requestId)).to.be.false;
      await issuer.connect(operator).issueNFT(user.address, tokenId, 1, requestId, oracleData);
      expect(await issuer.issued(requestId)).to.be.true;
    });
  });

  // ── issueActivityNFT ─────────────────────────────────────────────────────

  describe('issueActivityNFT', () => {
    it('activityId 기반 발행 성공 → Issued 이벤트 emit', async () => {
      const tokenId = await nft.encodeTokenId(1n, 42n);
      const activityId = ethers.id('activity-walk-042');
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const oracleData = await makeOracleData(oracleSigner, 'ACTIVITY', 1n, timestamp);

      await expect(
        issuer.connect(operator).issueActivityNFT(user.address, tokenId, activityId, oracleData),
      ).to.emit(issuer, 'Issued').withArgs(user.address, tokenId, activityId);

      expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });
  });

  // ── issueBatch ──────────────────────────────────────────────────────────

  describe('issueBatch', () => {
    it('배치 발행 성공 → 각 수령인 잔액 증가', async () => {
      const [, , , recipient1, recipient2] = await ethers.getSigners();
      const [id1, id2] = await Promise.all([
        nft.encodeTokenId(1n, 50n),
        nft.encodeTokenId(2n, 51n),
      ]);
      const requestId = ethers.id('batch-001');

      await issuer.connect(operator).issueBatch(
        [recipient1.address, recipient2.address],
        [id1, id2],
        [1, 1],
        requestId,
      );

      expect(await nft.balanceOf(recipient1.address, id1)).to.equal(1n);
      expect(await nft.balanceOf(recipient2.address, id2)).to.equal(1n);
    });

    it('MAX_BATCH_SIZE(500) 초과 시 revert', async () => {
      const MAX = 501;
      const addresses = Array(MAX).fill(user.address);
      const ids = Array.from({ length: MAX }, (_, i) => BigInt(i + 1));
      const amounts = Array(MAX).fill(1n);

      await expect(
        issuer.connect(operator).issueBatch(addresses, ids, amounts, ethers.id('batch-big')),
      ).to.be.revertedWith('NFTIssuer: batch too large - split in 500');
    });
  });
});

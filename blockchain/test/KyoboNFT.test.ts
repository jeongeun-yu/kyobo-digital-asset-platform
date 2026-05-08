/**
 * KyoboNFT 테스트 — Phase 1 행동 보상 NFT (ERC-1155 UUPS)
 */

import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { KyoboNFT } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('KyoboNFT (ERC-1155 UUPS)', () => {
  let nft: KyoboNFT;
  let admin: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async () => {
    [admin, minter, user, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory('KyoboNFT');
    nft = (await upgrades.deployProxy(Factory, [admin.address], { kind: 'uups' })) as unknown as KyoboNFT;
    await nft.waitForDeployment();

    // minter에게 MINTER_ROLE 부여
    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).grantRole(MINTER_ROLE, minter.address);
  });

  // ── 배포 ────────────────────────────────────────────────────────────────

  describe('배포', () => {
    it('admin에게 DEFAULT_ADMIN_ROLE 부여', async () => {
      const role = await nft.DEFAULT_ADMIN_ROLE();
      expect(await nft.hasRole(role, admin.address)).to.be.true;
    });

    it('admin에게 MINTER_ROLE / PAUSER_ROLE / UPGRADER_ROLE 부여', async () => {
      const [MINTER, PAUSER, UPGRADER] = await Promise.all([
        nft.MINTER_ROLE(), nft.PAUSER_ROLE(), nft.UPGRADER_ROLE(),
      ]);
      expect(await nft.hasRole(MINTER,   admin.address)).to.be.true;
      expect(await nft.hasRole(PAUSER,   admin.address)).to.be.true;
      expect(await nft.hasRole(UPGRADER, admin.address)).to.be.true;
    });

    it('초기 pause 상태 false', async () => {
      expect(await nft.paused()).to.be.false;
    });
  });

  // ── tokenId 인코딩 ────────────────────────────────────────────────────

  describe('tokenId 인코딩 / 디코딩', () => {
    it('encodeTokenId(0x01, 42) — 상위 64비트 productCode, 하위 64비트 eventCode', async () => {
      const tokenId = await nft.encodeTokenId(1n, 42n);
      const expected = (1n << 64n) | 42n;
      expect(tokenId).to.equal(expected);
    });

    it('decodeTokenId — 역방향 복원', async () => {
      const tokenId = await nft.encodeTokenId(2n, 100n);
      const [productCode, eventCode] = await nft.decodeTokenId(tokenId);
      expect(productCode).to.equal(2n);
      expect(eventCode).to.equal(100n);
    });

    it('다른 productCode → 다른 tokenId', async () => {
      const id1 = await nft.encodeTokenId(1n, 1n);
      const id2 = await nft.encodeTokenId(2n, 1n);
      expect(id1).to.not.equal(id2);
    });
  });

  // ── mint ────────────────────────────────────────────────────────────

  describe('mint', () => {
    it('MINTER_ROLE 보유자 mint 성공 → balanceOf 증가', async () => {
      const tokenId = await nft.encodeTokenId(1n, 1n);
      await nft.connect(minter).mint(user.address, tokenId, 1);
      expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });

    it('mint 시 TransferSingle 이벤트 emit', async () => {
      const tokenId = await nft.encodeTokenId(1n, 2n);
      await expect(nft.connect(minter).mint(user.address, tokenId, 1))
        .to.emit(nft, 'TransferSingle')
        .withArgs(minter.address, ethers.ZeroAddress, user.address, tokenId, 1n);
    });

    it('MINTER_ROLE 없는 계정 mint 시 revert', async () => {
      const tokenId = await nft.encodeTokenId(1n, 3n);
      await expect(nft.connect(stranger).mint(user.address, tokenId, 1))
        .to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
    });

    it('amount=0 mint 시 revert', async () => {
      const tokenId = await nft.encodeTokenId(1n, 4n);
      await expect(nft.connect(minter).mint(user.address, tokenId, 0))
        .to.be.revertedWith('KyoboNFT: zero amount');
    });
  });

  // ── mintBatch ────────────────────────────────────────────────────────

  describe('mintBatch', () => {
    it('여러 수령인에게 일괄 발행 성공', async () => {
      const [id1, id2] = await Promise.all([
        nft.encodeTokenId(1n, 10n),
        nft.encodeTokenId(2n, 20n),
      ]);
      const [, , recipient1, recipient2] = await ethers.getSigners();

      await nft.connect(minter).mintBatch(
        [recipient1.address, recipient2.address],
        [id1, id2],
        [1, 1],
      );

      expect(await nft.balanceOf(recipient1.address, id1)).to.equal(1n);
      expect(await nft.balanceOf(recipient2.address, id2)).to.equal(1n);
    });

    it('배열 길이 불일치 시 revert', async () => {
      await expect(
        nft.connect(minter).mintBatch([user.address], [1n, 2n], [1n])
      ).to.be.revertedWith('KyoboNFT: length mismatch');
    });
  });

  // ── burn ────────────────────────────────────────────────────────────

  describe('burn', () => {
    it('MINTER_ROLE 보유자 burn 성공 → balanceOf 감소', async () => {
      const tokenId = await nft.encodeTokenId(1n, 99n);
      await nft.connect(minter).mint(user.address, tokenId, 3);
      await nft.connect(minter).burn(user.address, tokenId, 2);
      expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });
  });

  // ── Pause ────────────────────────────────────────────────────────────

  describe('Pause', () => {
    it('pause 후 mint 시 revert', async () => {
      await nft.connect(admin).pause();
      const tokenId = await nft.encodeTokenId(1n, 5n);
      await expect(nft.connect(minter).mint(user.address, tokenId, 1))
        .to.be.revertedWithCustomError(nft, 'EnforcedPause');
    });

    it('unpause 후 mint 재개', async () => {
      await nft.connect(admin).pause();
      await nft.connect(admin).unpause();
      const tokenId = await nft.encodeTokenId(1n, 6n);
      await nft.connect(minter).mint(user.address, tokenId, 1);
      expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });

    it('PAUSER_ROLE 없는 계정 pause 시 revert', async () => {
      await expect(nft.connect(stranger).pause())
        .to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
    });
  });
});

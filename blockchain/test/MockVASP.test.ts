/**
 * MockVASP 테스트 — 시나리오별 동작 검증
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';
import { MockVASP } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const TOKEN_ID = 1001n;
const AMOUNT   = 1n;
const REASON   = ethers.encodeBytes32String('WALK_GOAL_MET');

function log(label: string, value?: unknown) {
  const val = value === undefined ? '' : JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  console.log(`    │  ${label}${val ? ': ' + val : ''}`);
}

describe('MockVASP', () => {
  let contract:  MockVASP;
  let admin:     HardhatEthersSigner;
  let operator:  HardhatEthersSigner;
  let user:      HardhatEthersSigner;
  let stranger:  HardhatEthersSigner;

  beforeEach(async () => {
    [admin, operator, user, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MockVASP');
    contract      = (await Factory.deploy(operator.address)) as unknown as MockVASP;
    await contract.waitForDeployment();
    log('MockVASP 배포', await contract.getAddress());
    log('operator', operator.address);
    log('user    ', user.address);
  });

  // ── [1] NORMAL ──────────────────────────────────────────────────────────

  it('[1] NORMAL: issueActivityNFT → ERC-1155 mint + Issued 이벤트', async () => {
    console.log('');
    log('mode 설정', 'NORMAL(0)');
    log('tokenId', TOKEN_ID.toString());
    log('reason ', ethers.decodeBytes32String(REASON));

    const op      = contract.connect(operator);
    const tx      = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
    const receipt = await tx.wait();
    log('txHash ', receipt!.hash);
    log('block  ', receipt!.blockNumber);
    log('gasUsed', receipt!.gasUsed.toString());

    const parsed = receipt!.logs
      .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    parsed.forEach(e => log(`event  [${e!.name}]`, Object.fromEntries(
      e!.fragment.inputs.map((inp, i) => [inp.name, e!.args[i]?.toString()])
    )));

    const bal = await contract.balanceOf(user.address, TOKEN_ID);
    log('balanceOf(user, tokenId)', bal.toString());

    await expect(op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON))
      .to.emit(contract, 'Issued')
      .withArgs(user.address, TOKEN_ID, REASON);
    expect(bal).to.equal(AMOUNT);
  });

  // ── [2] REVERT ──────────────────────────────────────────────────────────

  it('[2] REVERT: TX revert (기본 메시지)', async () => {
    console.log('');
    const op = contract.connect(operator);

    log('setMode → REVERT(1)');
    const modeTx = await op.setMode(1);
    await modeTx.wait();
    log('현재 mode', (await contract.mode()).toString() + ' (REVERT)');

    log('issueActivityNFT 호출 → revert 예상');
    await expect(op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON))
      .to.be.revertedWith('MockVASP: forced revert');
    log('revert 메시지', 'MockVASP: forced revert ✔');

    const bal = await contract.balanceOf(user.address, TOKEN_ID);
    log('balanceOf(user, tokenId) — mint 안 됨', bal.toString());
    expect(bal).to.equal(0n);
  });

  it('[2-a] REVERT: 커스텀 revert 메시지', async () => {
    console.log('');
    const op = contract.connect(operator);

    await (await op.setMode(1)).wait();
    const customMsg = 'ERC1155: insufficient balance';
    await (await op.setRevertReason(customMsg)).wait();
    log('setRevertReason', customMsg);
    log('현재 revertReason', await contract.revertReason());

    await expect(op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON))
      .to.be.revertedWith(customMsg);
    log('커스텀 revert 확인 ✔');
  });

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────

  it('[3] NO_EMIT: mint 성공, Issued 이벤트 없음', async () => {
    console.log('');
    const op = contract.connect(operator);

    log('setMode → NO_EMIT(2)');
    await (await op.setMode(2)).wait();
    log('현재 mode', (await contract.mode()).toString() + ' (NO_EMIT)');

    const tx      = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
    const receipt = await tx.wait();
    log('txHash ', receipt!.hash);
    log('block  ', receipt!.blockNumber);

    const allEvents = receipt!.logs
      .map(l => { try { return contract.interface.parseLog(l)?.name; } catch { return null; } })
      .filter(Boolean);
    log('emit된 이벤트 목록', allEvents);

    const issuedCount = allEvents.filter(n => n === 'Issued').length;
    log('Issued 이벤트 수 (0이어야 함)', issuedCount);

    const bal = await contract.balanceOf(user.address, TOKEN_ID);
    log('balanceOf(user, tokenId) — mint는 됨', bal.toString());

    expect(issuedCount).to.equal(0);
    expect(bal).to.equal(AMOUNT);
  });

  // ── [4] 접근 제어 ────────────────────────────────────────────────────────

  it('[4] OPERATOR_ROLE 없는 계정 → issueActivityNFT revert', async () => {
    console.log('');
    log('stranger', stranger.address);
    log('OPERATOR_ROLE 보유 여부', 'false');
    log('issueActivityNFT 호출 → revert 예상');
    await expect(
      contract.connect(stranger).issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON)
    ).to.be.reverted;
    log('접근 거부 확인 ✔');
  });

  it('[4-a] OPERATOR_ROLE 없는 계정 → setMode revert', async () => {
    console.log('');
    log('stranger → setMode(1) 시도');
    await expect(contract.connect(stranger).setMode(1)).to.be.reverted;
    log('접근 거부 확인 ✔');
  });

  // ── [5] 모드 전환 ────────────────────────────────────────────────────────

  it('[5] 모드 전환: NORMAL → REVERT → NO_EMIT → NORMAL', async () => {
    console.log('');
    const op = contract.connect(operator);
    const modeNames = ['NORMAL', 'REVERT', 'NO_EMIT'];

    log('초기 mode', `${await contract.mode()} (${modeNames[0]})`);
    expect(await contract.mode()).to.equal(0n);

    for (const [idx, name] of [[1, 'REVERT'], [2, 'NO_EMIT'], [0, 'NORMAL']] as [number, string][]) {
      await (await op.setMode(idx)).wait();
      const cur = await contract.mode();
      log(`setMode(${idx}) → mode`, `${cur} (${name})`);
      expect(cur).to.equal(BigInt(idx));
    }

    log('NORMAL 복귀 후 정상 발행 시도');
    await expect(op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON))
      .to.emit(contract, 'Issued');
    log('Issued 이벤트 확인 ✔');
  });

  // ── [6] 복수 발행 ────────────────────────────────────────────────────────

  it('[6] 동일 주소에 여러 번 발행 → balanceOf 누적', async () => {
    console.log('');
    const op = contract.connect(operator);

    for (let i = 1; i <= 3; i++) {
      const tx = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
      await tx.wait();
      const bal = await contract.balanceOf(user.address, TOKEN_ID);
      log(`발행 #${i} → balanceOf`, bal.toString());
    }

    expect(await contract.balanceOf(user.address, TOKEN_ID)).to.equal(3n);
  });
});

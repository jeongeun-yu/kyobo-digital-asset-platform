/**
 * test-anvil-adapter.ts — AnvilVASPAdapter 실 동작 검증 스크립트
 *
 * 실행:
 *   npx hardhat run scripts/test-anvil-adapter.ts --network localhost
 *
 * 사전 조건:
 *   npx hardhat node  (별도 터미널)
 */

import { ethers } from 'hardhat';

const TOKEN_ID = 1001n;
const AMOUNT   = 1n;
const REASON   = ethers.encodeBytes32String('WALK_GOAL_MET');

const MODE_NAMES = ['NORMAL', 'REVERT', 'NO_EMIT'];

const ABI = [
  'function issueActivityNFT(address to, uint256 tokenId, uint256 amount, bytes32 reason)',
  'function setMode(uint8 _mode)',
  'function setRevertReason(string reason)',
  'function mode() view returns (uint8)',
  'function revertReason() view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)',
];

function step(n: string, title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  [${n}] ${title}`);
  console.log(`${'─'.repeat(60)}`);
}
function info(label: string, value: unknown) {
  const v = typeof value === 'bigint' ? value.toString() : String(value);
  console.log(`  ·  ${label.padEnd(28)} ${v}`);
}
function ok(msg: string)   { console.log(`  ✔  ${msg}`); }
function fail(msg: string) { console.error(`  ✘  ${msg}`); process.exit(1); }

async function main() {
  const [, operator, user] = await ethers.getSigners();
  const send = (method: string, params: unknown[] = []) =>
    (ethers.provider as ethers.JsonRpcProvider).send(method, params);

  // ── 배포 ──────────────────────────────────────────────────────────────
  step('DEPLOY', 'MockVASP 컨트랙트 배포');
  const Factory  = await ethers.getContractFactory('MockVASP');
  const deployed = await Factory.deploy(operator.address);
  await deployed.waitForDeployment();
  const addr     = await deployed.getAddress();

  info('컨트랙트 주소', addr);
  info('operator    ', operator.address);
  info('user        ', user.address);
  info('초기 mode   ', `${await deployed.mode()} (NORMAL)`);

  const op      = new ethers.Contract(addr, ABI, operator);
  const view    = new ethers.Contract(addr, ABI, ethers.provider);

  // ── [1] NORMAL ──────────────────────────────────────────────────────────
  step('1', 'NORMAL — 정상 발행 + Issued 이벤트');

  info('mode', `${await view.mode()} (NORMAL)`);
  info('발행 대상 (to)', user.address);
  info('tokenId', TOKEN_ID.toString());
  info('amount ', AMOUNT.toString());
  info('reason ', ethers.decodeBytes32String(REASON));

  const tx1     = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
  info('TX 해시', tx1.hash);
  const r1      = await tx1.wait();
  info('블록 번호', r1.blockNumber);
  info('가스 사용량', r1.gasUsed.toString());

  const events1 = r1.logs
    .map((l: any) => { try { return op.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean);
  events1.forEach((e: any) => {
    info(`이벤트 [${e.name}] to`, e.args[0]);
    info(`이벤트 [${e.name}] tokenId`, e.args[1].toString());
    info(`이벤트 [${e.name}] reason`, ethers.decodeBytes32String(e.args[2]));
  });

  const bal1 = await view.balanceOf(user.address, TOKEN_ID);
  info('balanceOf(user, tokenId) 후', bal1.toString());
  Number(bal1) === 1 ? ok('Issued 이벤트 emit + balanceOf=1 확인') : fail('NORMAL 시나리오 실패');

  // ── [2] REVERT ──────────────────────────────────────────────────────────
  step('2', 'REVERT — TX revert 시뮬레이션');

  await (await op.setMode(1)).wait();
  info('setMode → REVERT(1)', `현재 mode: ${await view.mode()} (${MODE_NAMES[Number(await view.mode())]})`);
  info('revertReason', await view.revertReason());

  try {
    await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
    fail('revert 미발생');
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    info('에러 메시지 (일부)', msg.slice(0, 70));
    msg.includes('MockVASP: forced revert') ? ok('TX revert 확인') : fail('예상 외 에러');
  }

  await (await op.setRevertReason('ERC1155: insufficient balance')).wait();
  info('setRevertReason →', await view.revertReason());

  try {
    await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
    fail('revert 미발생');
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    info('에러 메시지 (일부)', msg.slice(0, 70));
    msg.includes('ERC1155: insufficient balance') ? ok('커스텀 revert 메시지 확인') : fail('예상 외 에러');
  }

  const balAfterRevert = await view.balanceOf(user.address, TOKEN_ID);
  info('balanceOf(user, tokenId) — mint 안 됨', balAfterRevert.toString());

  // NORMAL 복귀
  await (await op.setMode(0)).wait();
  await (await op.setRevertReason('MockVASP: forced revert')).wait();
  info('mode 복귀', `${await view.mode()} (NORMAL)`);

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────
  step('3', 'NO_EMIT — mint 성공, Issued 이벤트 없음');

  await (await op.setMode(2)).wait();
  info('setMode → NO_EMIT(2)', `현재 mode: ${await view.mode()} (${MODE_NAMES[Number(await view.mode())]})`);

  const tx3 = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
  info('TX 해시', tx3.hash);
  const r3  = await tx3.wait();
  info('블록 번호', r3.blockNumber);
  info('가스 사용량', r3.gasUsed.toString());

  const issuedLogs = r3.logs.filter((l: any) => {
    try { return op.interface.parseLog(l)?.name === 'Issued'; } catch { return false; }
  });
  const otherLogs = r3.logs.filter((l: any) => {
    try { return op.interface.parseLog(l)?.name !== 'Issued'; } catch { return true; }
  });

  info('Issued 이벤트 수 (0이어야 함)', issuedLogs.length);
  info('다른 이벤트 수 (TransferSingle 등)', otherLogs.length);
  const bal3 = await view.balanceOf(user.address, TOKEN_ID);
  info('balanceOf(user, tokenId) — mint는 됨', bal3.toString());

  issuedLogs.length === 0 && Number(bal3) > 1
    ? ok('Issued 없음 + mint 됨 → ChainEventListener 폴백 경로 검증 가능')
    : fail('NO_EMIT 시나리오 실패');

  // NORMAL 복귀
  await (await op.setMode(0)).wait();
  info('mode 복귀', `${await view.mode()} (NORMAL)`);

  // ── [4] PENDING ─────────────────────────────────────────────────────────
  step('4', 'PENDING — 블록 생성 중단 → TX 체류 → mineBlock → 확정');

  const balBefore4 = await view.balanceOf(user.address, TOKEN_ID);
  info('발행 전 balanceOf', balBefore4.toString());

  await send('evm_setAutomine', [false]);
  await send('evm_setIntervalMining', [0]);
  info('evm_setAutomine(false)', '블록 자동 생성 중단');

  const txPending = await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON);
  info('TX 제출 (pending)', txPending.hash);

  const balDuring4 = await view.balanceOf(user.address, TOKEN_ID);
  info('블록 생성 전 balanceOf', `${balDuring4} (변화 없음 — pending 체류 중)`);

  const blockBefore = await ethers.provider.getBlockNumber();
  info('현재 블록 번호 (채굴 전)', blockBefore);

  await send('evm_mine', []);
  await send('evm_setAutomine', [true]);
  await txPending.wait();

  const blockAfter = await ethers.provider.getBlockNumber();
  const balAfter4  = await view.balanceOf(user.address, TOKEN_ID);
  info('블록 채굴 후 블록 번호', blockAfter);
  info('블록 채굴 후 balanceOf', balAfter4.toString());

  balAfter4 > balBefore4
    ? ok('PENDING → 블록 채굴 → 확정 흐름 확인')
    : fail('PENDING 시나리오 실패');

  // ── [5] REORG ───────────────────────────────────────────────────────────
  step('5', 'REORG — snapshot → 발행 → revertToSnapshot → 원복');

  const balBefore5   = await view.balanceOf(user.address, TOKEN_ID);
  const blockBefore5 = await ethers.provider.getBlockNumber();
  info('스냅샷 직전 balanceOf', balBefore5.toString());
  info('스냅샷 직전 블록 번호', blockBefore5);

  const snapId = await send('evm_snapshot');
  info('evm_snapshot → id', snapId);

  await (await op.issueActivityNFT(user.address, TOKEN_ID, AMOUNT, REASON)).wait();
  const balMinted  = await view.balanceOf(user.address, TOKEN_ID);
  const blockMinted = await ethers.provider.getBlockNumber();
  info('발행 후 balanceOf', balMinted.toString());
  info('발행 후 블록 번호', blockMinted);

  info('evm_revert(snapId) 실행', '체인 롤백 중...');
  await send('evm_revert', [snapId]);

  const balReverted  = await view.balanceOf(user.address, TOKEN_ID);
  const blockReverted = await ethers.provider.getBlockNumber();
  info('REORG 후 balanceOf', `${balReverted} (← ${balBefore5} 원복)`);
  info('REORG 후 블록 번호', `${blockReverted} (← ${blockBefore5} 원복)`);

  balReverted === balBefore5
    ? ok('REORG 후 상태 원복 확인')
    : fail('REORG 시나리오 실패');

  // ── 완료 ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  모든 시나리오 통과 ✔');
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });

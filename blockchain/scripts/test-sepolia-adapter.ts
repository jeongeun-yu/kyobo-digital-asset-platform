/**
 * test-sepolia-adapter.ts — SepoliaVASPAdapter 실 동작 검증 스크립트
 *
 * 실행:
 *   npx hardhat run scripts/test-sepolia-adapter.ts --network sepolia
 *
 * 검증 항목 (Sepolia 지원 범위):
 *   [1] NORMAL  : issueActivityNFT → Issued 이벤트 + Etherscan 링크
 *   [2] REVERT  : TX revert (커스텀 메시지)
 *   [3] NO_EMIT : mint 성공, Issued 이벤트 없음
 *
 * 미검증 (Anvil 전용):
 *   PENDING / REORG — evm_setAutomine·evm_snapshot 은 Sepolia 노드 제어 불가
 */

import { ethers } from 'hardhat';

const MOCK_VASP_ADDR = '0x2e312C3bf494B100BbfAA916959330031B11fF38';
const TOKEN_ID       = 1001n;
const AMOUNT         = 1n;
const REASON         = ethers.encodeBytes32String('WALK_GOAL_MET');
const ETHERSCAN      = 'https://sepolia.etherscan.io';

const ABI = [
  'function issueActivityNFT(address to, uint256 tokenId, uint256 amount, bytes32 reason)',
  'function setMode(uint8 _mode)',
  'function setRevertReason(string reason)',
  'function mode() view returns (uint8)',
  'function revertReason() view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)',
];

const MODE_NAMES = ['NORMAL', 'REVERT', 'NO_EMIT'];

function step(n: string, title: string) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  [${n}] ${title}`);
  console.log(`${'─'.repeat(64)}`);
}
function info(label: string, value: unknown) {
  console.log(`  ·  ${label.padEnd(28)} ${String(value)}`);
}
function ok(msg: string)   { console.log(`  ✔  ${msg}`); }
function fail(msg: string) { console.error(`  ✘  ${msg}`); process.exit(1); }

async function main() {
  const [operator] = await ethers.getSigners();

  step('INIT', 'Sepolia 네트워크 연결 확인');
  const block = await ethers.provider.getBlockNumber();
  info('네트워크', 'Sepolia (chainId 11155111)');
  info('operator', operator.address);
  info('현재 블록', block);
  info('MockVASP', MOCK_VASP_ADDR);
  info('Etherscan', `${ETHERSCAN}/address/${MOCK_VASP_ADDR}`);

  const op   = new ethers.Contract(MOCK_VASP_ADDR, ABI, operator);
  const view = new ethers.Contract(MOCK_VASP_ADDR, ABI, ethers.provider);

  const initMode = await view.mode();
  info('현재 mode', `${initMode} (${MODE_NAMES[Number(initMode)]})`);

  // ── [1] NORMAL ──────────────────────────────────────────────────────────
  step('1', 'NORMAL — 정상 발행 + Issued 이벤트');

  // NORMAL 모드 확인 (이미 0이면 setMode 생략)
  if (Number(await view.mode()) !== 0) {
    console.log('  → setMode(NORMAL) 전송 중...');
    await (await op.setMode(0)).wait(1);
  }
  info('mode', `${await view.mode()} (NORMAL)`);
  info('tokenId', TOKEN_ID.toString());
  info('reason ', ethers.decodeBytes32String(REASON));

  const balBefore1 = await view.balanceOf(operator.address, TOKEN_ID);
  info('발행 전 balanceOf', balBefore1.toString());

  console.log('  → issueActivityNFT 전송 중... (블록 확정 대기)');
  const tx1     = await op.issueActivityNFT(operator.address, TOKEN_ID, AMOUNT, REASON);
  info('TX 해시', tx1.hash);
  info('Etherscan', `${ETHERSCAN}/tx/${tx1.hash}`);

  const r1 = await tx1.wait(1);
  info('블록 번호', r1!.blockNumber);
  info('가스 사용량', r1!.gasUsed.toString());

  const issuedLog = r1!.logs.find((l: any) => {
    try { return op.interface.parseLog(l)?.name === 'Issued'; } catch { return false; }
  });

  if (issuedLog) {
    const parsed = op.interface.parseLog(issuedLog)!;
    info('이벤트 [Issued] to     ', parsed.args[0]);
    info('이벤트 [Issued] tokenId', parsed.args[1].toString());
    info('이벤트 [Issued] reason ', ethers.decodeBytes32String(parsed.args[2]));
  }

  const balAfter1 = await view.balanceOf(operator.address, TOKEN_ID);
  info('발행 후 balanceOf', balAfter1.toString());
  issuedLog ? ok('Issued 이벤트 emit 확인') : fail('Issued 이벤트 없음');

  // ── [2] REVERT ──────────────────────────────────────────────────────────
  step('2', 'REVERT — TX revert 시뮬레이션');

  console.log('  → setMode(REVERT) 전송 중...');
  await (await op.setMode(1)).wait(1);
  info('mode', `${await view.mode()} (REVERT)`);
  info('revertReason', await view.revertReason());

  try {
    console.log('  → issueActivityNFT 전송 중... (revert 예상)');
    await op.issueActivityNFT(operator.address, TOKEN_ID, AMOUNT, REASON);
    fail('revert 미발생');
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    info('에러 메시지 (일부)', msg.slice(0, 72));
    msg.includes('MockVASP: forced revert') ? ok('TX revert 확인') : fail(`예상 외 에러: ${msg.slice(0, 60)}`);
  }

  console.log('  → 커스텀 revert 메시지 변경 중...');
  await (await op.setRevertReason('ERC1155: insufficient balance')).wait(1);
  info('revertReason 변경', await view.revertReason());

  try {
    await op.issueActivityNFT(operator.address, TOKEN_ID, AMOUNT, REASON);
    fail('revert 미발생');
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    msg.includes('ERC1155: insufficient balance')
      ? ok('커스텀 revert 메시지 확인')
      : fail(`예상 외 에러: ${msg.slice(0, 60)}`);
  }

  // NORMAL 복귀
  await (await op.setMode(0)).wait(1);
  await (await op.setRevertReason('MockVASP: forced revert')).wait(1);
  info('mode 복귀', `${await view.mode()} (NORMAL)`);

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────
  step('3', 'NO_EMIT — mint 성공, Issued 이벤트 없음');

  console.log('  → setMode(NO_EMIT) 전송 중...');
  await (await op.setMode(2)).wait(1);
  info('mode', `${await view.mode()} (NO_EMIT)`);

  const balBefore3 = await view.balanceOf(operator.address, TOKEN_ID);
  info('발행 전 balanceOf', balBefore3.toString());

  console.log('  → issueActivityNFT 전송 중... (블록 확정 대기)');
  const tx3 = await op.issueActivityNFT(operator.address, TOKEN_ID, AMOUNT, REASON);
  info('TX 해시', tx3.hash);
  info('Etherscan', `${ETHERSCAN}/tx/${tx3.hash}`);

  const r3 = await tx3.wait(1);
  info('블록 번호', r3!.blockNumber);
  info('가스 사용량', r3!.gasUsed.toString());

  const issuedLogs3 = r3!.logs.filter((l: any) => {
    try { return op.interface.parseLog(l)?.name === 'Issued'; } catch { return false; }
  });
  const otherLogs3 = r3!.logs.filter((l: any) => {
    try { return op.interface.parseLog(l)?.name !== 'Issued'; } catch { return true; }
  });

  info('Issued 이벤트 수 (0이어야 함)', issuedLogs3.length);
  info('다른 이벤트 수 (TransferSingle)', otherLogs3.length);

  const balAfter3 = await view.balanceOf(operator.address, TOKEN_ID);
  info('발행 후 balanceOf', balAfter3.toString());

  issuedLogs3.length === 0 && balAfter3 > balBefore3
    ? ok('Issued 없음 + mint 됨 → ChainEventListener 폴백 경로 시뮬레이션 성공')
    : fail('NO_EMIT 시나리오 실패');

  // NORMAL 복귀
  await (await op.setMode(0)).wait(1);
  info('mode 복귀', `${await view.mode()} (NORMAL)`);

  // ── 완료 ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(64)}`);
  console.log('  Sepolia 시나리오 전부 통과 ✔');
  console.log(`  컨트랙트: ${ETHERSCAN}/address/${MOCK_VASP_ADDR}`);
  console.log(`${'═'.repeat(64)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });

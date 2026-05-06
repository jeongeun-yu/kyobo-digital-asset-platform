/**
 * mintNFT 실습 테스트 — Sepolia MockERC1155
 * 실행: npx ts-node src/exercises/_check_mint.ts
 */
import { EVMAdapter } from '@kyobo/chain-adapters';
import { evmConfig, contractConfig } from '@kyobo/shared';

(async () => {
  const { rpcUrl, chainId, signerKey } = evmConfig;
  const contractAddr = contractConfig.mockERC1155;

  if (!signerKey)      { console.error('EVM_SIGNER_KEY 없음'); process.exit(1); }
  if (!contractAddr)   { console.error('MOCK_CONTRACT_ADDR 없음'); process.exit(1); }

  const adapter = new EVMAdapter({ rpcUrl, chainId, privateKey: signerKey });
  console.log('컨트랙트:', contractAddr);
  console.log('RPC:     ', rpcUrl);
  console.log('');

  const TO       = '0x91ffcbB6f6dC947C01d402eA5703b9D27e8aA363'; // 본인 주소
  const TOKEN_ID = 1n;
  const AMOUNT   = 1n;

  // ── mint 전 잔액 ────────────────────────────────────────────────────
  const before = await adapter.getBalance(contractAddr, TO, TOKEN_ID);
  console.log(`mint 전 잔액 (tokenId=${TOKEN_ID}):`, before.toString());

  // ── mintNFT ─────────────────────────────────────────────────────────
  console.log('\nmintNFT 전송 중...');
  const receipt = await adapter.mintNFT({
    contractAddr,
    to:        TO,
    tokenId:   TOKEN_ID,
    amount:    AMOUNT,
    requestId: `test-${Date.now()}`,
  });

  console.log('TX Hash:    ', receipt.txHash);
  console.log('Block:      ', receipt.blockNumber);
  console.log('Status:     ', receipt.status);
  console.log('Gas Used:   ', receipt.gasUsed?.toString());

  // ── mint 후 잔액 ────────────────────────────────────────────────────
  const after = await adapter.getBalance(contractAddr, TO, TOKEN_ID);
  console.log(`\nmint 후 잔액 (tokenId=${TOKEN_ID}):`, after.toString());
  console.log(after > before ? '✅ 잔액 증가 확인' : '❌ 잔액 변화 없음');

  process.exit(0);
})();

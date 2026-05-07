import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { evmConfig } from '@kyobo/shared';

(async () => {
  const { rpcUrl, signerKey } = evmConfig;
  if (!signerKey) { console.log('EVM_SIGNER_KEY 없음 — .env 확인'); process.exit(1); }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet   = new Wallet(signerKey, provider);
  const balance  = await provider.getBalance(wallet.address);

  console.log('주소:  ', wallet.address);
  console.log('잔액:  ', formatEther(balance), 'ETH (Sepolia)');
  process.exit(0);
})();

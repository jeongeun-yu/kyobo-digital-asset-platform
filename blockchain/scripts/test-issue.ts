// S5 실습 Step 4 — NFT 발행 트랜잭션 실행
// 실행: npx hardhat run scripts/test-issue.ts --network localhost

import { ethers } from 'hardhat';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

async function main() {
  const signers = await ethers.getSigners();
  const deployer     = signers[0];
  const oracleSigner = signers[1];
  if (!deployer || !oracleSigner) throw new Error('Need at least 2 signers (deployer + oracleSigner)');
  console.log('발행 계정:', deployer.address);

  const nftProxyAddr  = process.env.KYOBO_NFT_PROXY_ADDR;
  const nftIssuerAddr = process.env.NFT_ISSUER_ADDR;

  if (!nftProxyAddr || !nftIssuerAddr) {
    throw new Error('.env에 KYOBO_NFT_PROXY_ADDR, NFT_ISSUER_ADDR 필요');
  }

  // OracleData 생성
  // IOracle.OracleData: { dataType, value, timestamp, signature }
  const dataType  = ethers.keccak256(ethers.toUtf8Bytes('ACTIVITY'));
  const value     = 10000n;  // 10,000 걸음
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  // ActivityOracle.verify()가 검증하는 서명 생성
  // solidityPackedKeccak256([dataType, value, timestamp])
  const msgHash   = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataType, value, timestamp],
  );
  const signature = await oracleSigner.signMessage(ethers.getBytes(msgHash));

  const oracleData = { dataType, value, timestamp, signature };

  // tokenId 생성
  const nft     = await ethers.getContractAt('KyoboNFT', nftProxyAddr) as unknown as { encodeTokenId(a: bigint, b: bigint): Promise<bigint> };
  const tokenId = await nft.encodeTokenId(1n, BigInt(Date.now() % 100000));

  // activityId — reason으로 Issued 이벤트에 포함됨
  const activityId = ethers.keccak256(
    ethers.toUtf8Bytes(`activity-${Date.now()}`),
  ) as `0x${string}`;

  // NFTIssuer.issueActivityNFT() 호출
  const issuer = await ethers.getContractAt('NFTIssuer', nftIssuerAddr) as unknown as { issueActivityNFT(...args: unknown[]): Promise<{ hash: string; wait(): Promise<{ blockNumber: number } | null> }> };

  console.log('NFT 발행 중...');
  const tx      = await issuer.issueActivityNFT(deployer.address, tokenId, activityId, oracleData);
  const receipt = await tx.wait();

  console.log('발행 완료!');
  console.log('  txHash:      ', tx.hash);
  console.log('  blockNumber: ', receipt?.blockNumber);
  console.log('  tokenId:     ', tokenId.toString());
  console.log('  activityId:  ', activityId);
}

main().catch(console.error);

import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
    },
  },
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
    // Mainnet fork — MAINNET_RPC_URL 설정 시 활성화 (S4 실습 환경 3)
    hardhat: {
      forking: {
        url:     process.env.MAINNET_RPC_URL ?? '',
        enabled: !!process.env.MAINNET_RPC_URL,
      },
    },
    // 테스트넷 (교육 Day 07 배포 실습)
    sepolia: {
      url:      process.env.SEPOLIA_RPC_URL ?? '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // 메인넷 (프로덕션 — 체인 미확정, 명시적 승인 후만 사용)
    mainnet: {
      url:      process.env.MAINNET_RPC_URL ?? '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? '',
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
  },
  paths: {
    sources:   './src',
    tests:     './test',
    artifacts: './artifacts',
  },
};

export default config;

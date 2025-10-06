import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";
import "@nomicfoundation/hardhat-verify";
import dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "http://localhost:8545";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
  },
  paths: {
    tests: "hardhat-test",
  },
  networks: {
    pNet: {
      url: RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    hardhat: {
      chainId: 31337,
      gas: "auto",
      gasPrice: "auto",
      mining: {
        auto: true,
        interval: 0,
      },
    },
    devnet: {
      url: "https://devnetstats.hashlabs.apothem.network/devnet",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      timeout: 60000,
      gasPrice: 300000000000,
      gas: 2100000,
      chainId: 551,
    },
  },
  mocha: {
    timeout: 100000,
  },
};

export default config;

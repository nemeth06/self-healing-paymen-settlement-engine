import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";

const config: HardhatUserConfig = {
  solidity: "0.8.19",
  networks: {
    hardhat: {
      chainId: 31337,
      /*
      forking: {
        enabled: false,
      },*/
      allowUnlimitedContractSize: true,
      loggingEnabled: false,
      accounts: [
        {
          privateKey:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb476c6b8d6c6712b08d077d5e592",
          balance: "1000000000000000000000", // 1000 ETH
        },
        {
          privateKey:
            "0x70997970c51812e339d9b73b0245ad59c5f2f45e86d8ee7d5cb31cc9e44e9425",
          balance: "1000000000000000000000",
        },
      ],
    },
    localhost: {
      url: "http://localhost:8545",
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb476c6b8d6c6712b08d077d5e592",
        "0x70997970c51812e339d9b73b0245ad59c5f2f45e86d8ee7d5cb31cc9e44e9425",
      ],
    },
  },
};

export default config;

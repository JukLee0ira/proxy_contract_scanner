import { JsonRpcProvider } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://earpc.apothem.network/";

describe("Apothem RPC 连通性", () => {
  it("应能获取最新区块高度", async () => {
    const provider = new JsonRpcProvider(RPC_URL);
    const blockNumber = await provider.getBlockNumber();
    expect(blockNumber).toBeGreaterThan(0);
  });

  it("应能读取网络 chainId", async () => {
    const provider = new JsonRpcProvider(RPC_URL);
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    expect(chainId).toBeGreaterThan(0);
  });
});



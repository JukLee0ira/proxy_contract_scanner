import dotenv from "dotenv";

// 统一加载 .env，方便在本地或 CI 中配置 RPC_URL、PRIVATE_KEY 等
dotenv.config();

// 如果没有显式配置 RPC_URL，则默认指向 Apothem 测试网
if (!process.env.RPC_URL) {
  // 来自文档中的 Apothem RPC 默认地址
  process.env.RPC_URL = "https://earpc.apothem.network/";
}

// 放宽 Jest 的默认超时时间，避免网络波动导致测试过早失败
jest.setTimeout(30_000);



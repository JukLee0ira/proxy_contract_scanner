import hre from "hardhat";
import axios from "axios";

// 通过 any 绕过类型检查，运行时由 @nomicfoundation/hardhat-ethers 注入 ethers
const { ethers } = hre as any;

// 硬编码 Apothem 测试网参数（只在日志中展示，真正的 RPC 仍由 scanner 配置）
const APOTHEM_RPC_URL = "https://earpc.apothem.network/";
const APOTHEM_CHAIN_ID = 51;

// 与 xdcBootstrap.ts 一致的 HTTP API 默认地址，用于把地址“丢给”现有 scanner
const SCANNER_API_URL = process.env.SCANNER_API_URL || "http://localhost:3000";

async function main() {
  const network = await ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();

  console.log("========== Apothem Proxy1967 部署与扫描 Demo ==========");
  console.log("RPC_URL      :", APOTHEM_RPC_URL);
  console.log("ChainId      :", APOTHEM_CHAIN_ID.toString());
  console.log("Deployer     :", await deployer.getAddress());
  console.log("=====================================================");

  // 可选一致性检查：实际连接的链 ID 若与 51 不一致则给出警告
  if (Number(network.chainId) !== APOTHEM_CHAIN_ID) {
    console.warn(
      "[warning] 当前 hardhat 网络的 chainId ≠ 51，实际为:",
      network.chainId.toString()
    );
  }

  // 1) 部署 LogicV1
  const LogicV1 = await ethers.getContractFactory("LogicV1", deployer);
  const logicV1 = await LogicV1.deploy();
  await (logicV1 as any).waitForDeployment?.();
  const logicV1Address =
    (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
  const logicV1DeployTx = (logicV1 as any).deploymentTransaction?.();

  console.log("LogicV1 部署地址:", logicV1Address);
  if (logicV1DeployTx?.hash) {
    console.log(
      "LogicV1 部署交易:",
      logicV1DeployTx.hash,
      "\n  XDCScan:",
      `https://testnet.xdcscan.com/tx/${logicV1DeployTx.hash}`
    );
  }

  // 2) 部署 Proxy1967，指向 LogicV1
  const Proxy1967 = await ethers.getContractFactory("Proxy1967", deployer);
  const proxy = await Proxy1967.deploy(logicV1Address);
  await (proxy as any).waitForDeployment?.();
  const proxyAddress =
    (proxy as any).address ?? (await (proxy as any).getAddress());
  const proxyDeployTx = (proxy as any).deploymentTransaction?.();

  console.log("Proxy1967 部署地址:", proxyAddress);
  if (proxyDeployTx?.hash) {
    console.log(
      "Proxy1967 部署交易:",
      proxyDeployTx.hash,
      "\n  XDCScan:",
      `https://testnet.xdcscan.com/tx/${proxyDeployTx.hash}`
    );
  }
  console.log(
    "Proxy1967 地址在 XDCScan 上查看:",
    `https://testnet.xdcscan.com/address/${proxyAddress}`
  );

  // 3) 部署 LogicV2 并通过 Proxy1967.upgrade 升级
  console.log("\n[upgrade-demo] 开始部署 LogicV2 并执行 Proxy1967.upgrade()...");
  const LogicV2 = await ethers.getContractFactory("LogicV2", deployer);
  const logicV2 = await LogicV2.deploy();
  await (logicV2 as any).waitForDeployment?.();
  const logicV2Address =
    (logicV2 as any).address ?? (await (logicV2 as any).getAddress());
  const logicV2DeployTx = (logicV2 as any).deploymentTransaction?.();

  console.log("LogicV2 部署地址:", logicV2Address);
  if (logicV2DeployTx?.hash) {
    console.log(
      "LogicV2 部署交易:",
      logicV2DeployTx.hash,
      "\n  XDCScan:",
      `https://testnet.xdcscan.com/tx/${logicV2DeployTx.hash}`
    );
  }

  console.log("[upgrade-demo] 调用 Proxy1967.upgrade(logicV2) 进行升级...");
  const upgradeTx = await (proxy as any).upgrade(logicV2Address);
  const upgradeReceipt = await upgradeTx.wait();
  if (upgradeReceipt?.hash) {
    console.log(
      "[upgrade-demo] 升级交易哈希:",
      upgradeReceipt.hash,
      "\n  XDCScan:",
      `https://testnet.xdcscan.com/tx/${upgradeReceipt.hash}`
    );
  }

  // 4) 把 Proxy 地址“交给”已有 scanner，由 scanner 内部逻辑（proxyScannerDemo.ts）做检测
  console.log(
    "\n[scanner-hook] 尝试通过 HTTP API /monitor 把 Proxy 地址交给 scanner：",
    SCANNER_API_URL
  );
  try {
    const res = await axios.post(
      `${SCANNER_API_URL}/monitor`,
      { address: proxyAddress },
      { timeout: 10_000 }
    );
    console.log("[scanner-hook] /monitor 响应:", res.data);
    console.log(
      "[scanner-hook] ✅ Proxy 地址已交由 scanner 处理，具体检测/存储槽解析/事件监听逻辑由 proxyScannerDemo.ts 内部完成，请查看 scanner 控制台日志。"
    );
  } catch (e: any) {
    console.warn(
      "[scanner-hook] ⚠️ 调用 /monitor 失败（可能是 scanner/API 未启动），请确认已运行 src/index.ts：",
      e?.message || String(e)
    );
  }

  console.log("\n[scanner-demo] 你现在可以在浏览器中打开以上 XDCScan 链接：");
  console.log("  - 确认 LogicV1、Proxy1967 部署交易是否成功");
  console.log("  - 对比本脚本输出的地址与链上记录是否一致");
  console.log(
    "示例参考交易（你提供的参考）：",
    "https://testnet.xdcscan.com/tx/0x38b0a2b7800da65533579c096237c173ca6561d4b3df090c5331fe5c94a66683"
  );
}

main().catch((err) => {
  console.error("deployProxy1967Apothem.ts 运行失败:", err);
  process.exit(1);
});




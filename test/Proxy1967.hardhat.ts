import { expect } from "chai";
import { ethers } from "hardhat";

describe("Proxy1967 E2E (Hardhat)", function () {
  it("deploys V1, proxies, upgrades to V2, and verifies state", async function () {
    const [deployer] = await ethers.getSigners();

    const LogicV1 = await ethers.getContractFactory("LogicV1", deployer);
    const logicV1 = await LogicV1.deploy();
    await logicV1.deployed?.();
    const logicV1Address = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());

    const Proxy = await ethers.getContractFactory("Proxy1967", deployer);
    const proxy = await Proxy.deploy(logicV1Address);
    await proxy.deployed?.();
    const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());

    // Interact through proxy as LogicV1
    const proxyAsV1 = LogicV1.attach(proxyAddress).connect(deployer);
    const txSet = await (proxyAsV1 as any).setX(10);
    await txSet.wait();
    const x1 = await (proxyAsV1 as any).x();
    expect(x1.toString()).to.equal("10");
    const v1 = await (proxyAsV1 as any).version();
    expect(v1).to.equal("V1");

    // Deploy V2 and upgrade proxy
    const LogicV2 = await ethers.getContractFactory("LogicV2", deployer);
    const logicV2 = await LogicV2.deploy();
    await logicV2.deployed?.();
    const logicV2Address = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());
    const tx = await (proxy as any).upgrade(logicV2Address);
    await tx.wait();

    // Interact through proxy as LogicV2
    const proxyAsV2 = LogicV2.attach(proxyAddress).connect(deployer);
    const txAdd = await (proxyAsV2 as any).add(5);
    await txAdd.wait();
    const x2 = await (proxyAsV2 as any).x();
    expect(x2.toString()).to.equal("15");
    const v2 = await (proxyAsV2 as any).version();
    expect(v2).to.equal("V2");
  });
});



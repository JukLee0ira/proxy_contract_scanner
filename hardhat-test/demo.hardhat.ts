import { expect } from "chai";
import { ethers } from "hardhat";

// Utilities
function extractAddressFromSlot(value: string): string {
    const hex = (value || '').startsWith('0x') ? (value as string).slice(2) : (value as string);
    const padded = hex.padStart(64, '0');
    const last40 = padded.slice(-40);
    return '0x' + last40;
}

async function getStorageAt(address: string, slot: string): Promise<string> {
    return await ethers.provider.send("eth_getStorageAt", [address, slot, "latest"]);
}

describe('Demo Scanner Behavior', function () {
    let logicV1: any;
    let logicV2: any;
    let proxy1967: any;
    let proxyNo1967: any;

    before(async () => {
        const LogicV1 = await ethers.getContractFactory('LogicV1');
        const LogicV2 = await ethers.getContractFactory('LogicV2');
        const Proxy1967 = await ethers.getContractFactory('Proxy1967');
        const ProxyNo1967 = await ethers.getContractFactory('ProxyNo1967');

        logicV1 = await LogicV1.deploy();
        await (logicV1 as any).deployed?.();
        logicV2 = await LogicV2.deploy();
        await (logicV2 as any).deployed?.();

        const logicV1Addr = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
        proxy1967 = await Proxy1967.deploy(logicV1Addr);
        await (proxy1967 as any).deployed?.();

        proxyNo1967 = await ProxyNo1967.deploy(logicV1Addr);
        await (proxyNo1967 as any).deployed?.();
    });

    describe('Standard proxy: detect upgrades via event', () => {
        it('should capture Upgraded event on upgrade', async () => {
            const proxyAddr = (proxy1967 as any).address ?? (await (proxy1967 as any).getAddress());
            const logicV2Addr = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());

            const upgradeEvents: any[] = [];
            (proxy1967 as any).on('Upgraded', (newImplementation: string, event: any) => {
                upgradeEvents.push({
                    newImplementation,
                    transactionHash: (event?.log?.transactionHash ?? event?.transactionHash),
                    blockNumber: (event?.log?.blockNumber ?? event?.blockNumber)
                });
            });

            const tx = await (proxy1967 as any).upgrade(logicV2Addr);
            const receipt = await tx.wait();

            await new Promise(r => setTimeout(r, 500));

            expect(upgradeEvents).to.have.length(1);
            expect(upgradeEvents[0].newImplementation.toLowerCase()).to.equal(logicV2Addr.toLowerCase());
            expect(upgradeEvents[0].transactionHash).to.equal(receipt?.hash);

            // Also verify storage reflects the new implementation (EIP-1967)
            const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
            const v = await getStorageAt(proxyAddr, implSlot);
            const extracted = extractAddressFromSlot(v);
            expect(extracted.toLowerCase()).to.equal(logicV2Addr.toLowerCase());
        });
    });

    describe('Non-standard proxy: detect and track via storage slot scanning', () => {
        it('should detect implementation from custom slot and track upgrades', async () => {
            const proxyAddr = (proxyNo1967 as any).address ?? (await (proxyNo1967 as any).getAddress());
            const logicV1Addr = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            const logicV2Addr = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());

            // The custom slot is keccak256("simple.proxy.impl")
            const customSlot = (ethers as any).id('simple.proxy.impl');

            // Read initial implementation address from slot
            const initialRaw = await getStorageAt(proxyAddr, customSlot);
            const initialImpl = extractAddressFromSlot(initialRaw);
            expect(initialImpl.toLowerCase()).to.equal(logicV1Addr.toLowerCase());

            // Perform upgrade (no event emitted)
            const tx = await (proxyNo1967 as any).upgrade(logicV2Addr);
            await tx.wait();

            // Re-read storage slot and ensure it changed
            const afterRaw = await getStorageAt(proxyAddr, customSlot);
            const afterImpl = extractAddressFromSlot(afterRaw);
            expect(afterImpl.toLowerCase()).to.equal(logicV2Addr.toLowerCase());
            expect(afterImpl.toLowerCase()).to.not.equal(initialImpl.toLowerCase());
        });
    });
});



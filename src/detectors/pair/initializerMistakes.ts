import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

export const InitializerMistakesPairDetector: PairDetector = {
    name: 'initializer_mistakes',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const rpcUrl : string =process.env.RPC_URL || 'https://rpc.ankr.com/xdc/ ';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const proxy = ctx.proxy.address.toLowerCase();
        const logicCtx = ctx.logic.address.toLowerCase();

        const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

        function isZeroHex(hex?: string): boolean {
            if (!hex) return true;
            if (!hex.startsWith('0x')) return false;
            const clean = hex.slice(2);
            if (clean.length === 0) return true;
            return /^0+$/.test(clean);
        }

        function parseAddressFromWord(word?: string): string | undefined {
            if (!word || !word.startsWith('0x')) return undefined;
            const clean = word.slice(2).padStart(64, '0');
            const addrHex = clean.slice(-40);
            const addr = ('0x' + addrHex).toLowerCase();
            if (/^0x0+$/.test(addr)) return undefined;
            return addr;
        }

        async function getStorageSlot(address: string, slotHex: string): Promise<string> {
            try {
                const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
                return typeof hex === 'string' ? hex : '0x';
            } catch {
                return '0x';
            }
        }

        // Step 1: Discover logic address from EIP-1967 slot (if available)
        const implWord = await getStorageSlot(proxy, EIP1967_IMPL_SLOT);
        const logicFromSlot = parseAddressFromWord(implWord);
        const logic = (logicFromSlot || logicCtx).toLowerCase();
        const implSlotResolved = !!logicFromSlot;
        const implMismatch = !!(logicFromSlot && logicFromSlot !== logicCtx);

        // Step 3: Check logic's INITIALIZED slot (slot 0 heuristic for OZ Initializable)
        const logicSlot0 = await getStorageSlot(logic, '0x0');
        const logicSlot0IsZero = isZeroHex(logicSlot0);

        // Step 4: Check proxy slot 0 (informational)
        const proxySlot0 = await getStorageSlot(proxy, '0x0');
        const proxySlot0IsZero = isZeroHex(proxySlot0);

        if (logicSlot0IsZero) {
            findings.push({
                id: 'initializer-mistakes-critical',
                title: 'Implementation appears uninitialized at slot 0 (initialize may be directly callable on logic)',
                severity: 'critical',
                metadata: {
                    proxyAddress: proxy,
                    logicAddress: logic,
                    logicAddressFromContext: logicCtx,
                    logicAddressFromEIP1967: logicFromSlot,
                    eip1967ImplSlotWord: implWord,
                    eip1967Resolved: implSlotResolved,
                    eip1967ContextMismatch: implMismatch,
                    logicSlot0,
                    proxySlot0,
                    notes: {
                        logicSlot0IsZero,
                        proxySlot0IsZero,
                        heuristic: 'OZ Initializable often stores _initialized/_initializing flags in slot 0',
                    }
                } as any,
            });
        } else {
            findings.push({
                id: 'initializer-mistakes-safe',
                title: 'Implementation shows initialized-like state at slot 0 (no initializer exposure detected)',
                severity: 'info',
                metadata: {
                    proxyAddress: proxy,
                    logicAddress: logic,
                    logicAddressFromContext: logicCtx,
                    logicAddressFromEIP1967: logicFromSlot,
                    eip1967ImplSlotWord: implWord,
                    eip1967Resolved: implSlotResolved,
                    eip1967ContextMismatch: implMismatch,
                    logicSlot0,
                    proxySlot0,
                    notes: {
                        logicSlot0IsZero,
                        proxySlot0IsZero,
                        heuristic: 'OZ Initializable often stores _initialized/_initializing flags in slot 0',
                    }
                } as any,
            });
        }

        return findings;
    }
};



import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function concatSources(sources?: Record<string, string>): string {
    if (!sources) return '';
    return Object.values(sources).join('\n\n');
}

function detectUnstructuredStoragePattern(proxySourceText: string): boolean {
    if (!proxySourceText) return false;
    const text = proxySourceText.toLowerCase();
    return text.includes('eip-1967') ||
        text.includes('_admin_slot') ||
        text.includes('_implementation_slot') ||
        /bytes32\s+constant\s+_[a-z_]*slot/.test(proxySourceText);
}

function countProxyStateVariablesHeuristic(proxySourceText: string): number {
    if (!proxySourceText) return 0;
    // Very rough heuristic: count likely state variable declarations excluding constants/immutables
    const regex = /\b(bool|address|uint(?:8|16|32|64|128|256)?)\s+(?:public|private|internal|external)?\s*[_A-Za-z][A-Za-z0-9_]*\s*(?:=\s*[^;]+)?\s*;/g;
    const constOrImmutable = /\b(constant|immutable)\b/;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(proxySourceText)) !== null) {
        const decl = match[0];
        if (!constOrImmutable.test(decl)) count++;
    }
    return count;
}

function detectLogicInitializerPatterns(logicSourceText: string): { hasPackedBools: boolean; hasNumericInitialized: boolean } {
    const text = logicSourceText || '';
    const hasBoolInitialized = /\bbool\s+_?initialized\b/.test(text);
    const hasBoolInitializing = /\bbool\s+_?initializing\b/.test(text);
    const hasPackedBools = hasBoolInitialized || hasBoolInitializing;
    const hasNumericInitialized = /\buint(?:8|256)?\s+_?initialized\b/.test(text);
    return { hasPackedBools, hasNumericInitialized };
}

function parseByte(hexWord: string, fromEndIndex: number): number {
    // hexWord like 0x[64 hex chars]; fromEndIndex: 0 = last byte, 1 = second last
    if (!hexWord || !hexWord.startsWith('0x')) return 0;
    const clean = hexWord.slice(2);
    const start = clean.length - (fromEndIndex + 1) * 2;
    if (start < 0) return 0;
    const byteHex = clean.slice(start, start + 2) || '00';
    return parseInt(byteHex, 16);
}

async function getStorageSlot0(provider: ethers.Provider, address: string): Promise<string> {
    const slotHex = '0x0';
    try {
        // Use raw RPC for compatibility across ethers versions
        const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
        return typeof hex === 'string' ? hex : '0x';
    } catch {
        return '0x';
    }
}

export const StorageCollisionPairDetector: PairDetector = {
    name: 'storage-collision',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const proxySourceText = concatSources(ctx.proxy.sources);
        const logicSourceText = concatSources(ctx.logic.sources);

        const unstructured = detectUnstructuredStoragePattern(proxySourceText);
        const proxyVarCount = countProxyStateVariablesHeuristic(proxySourceText);
        const logicPatterns = detectLogicInitializerPatterns(logicSourceText);

        const stage1Potential = !unstructured && proxyVarCount > 0 && (logicPatterns.hasPackedBools || logicPatterns.hasNumericInitialized);

        findings.push({
            id: 'storage-collision-stage1',
            title: 'Stage1: Static layout collision heuristic',
            severity: stage1Potential ? 'high' : 'info',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                proxy: { unstructured, proxyVarCount },
                logic: { hasPackedBools: logicPatterns.hasPackedBools, hasNumericInitialized: logicPatterns.hasNumericInitialized },
            } as any,
        });

        if (!stage1Potential) {
            return findings;
        }

        // Stage 2: On-chain state check on slot 0
        const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const slot0 = await getStorageSlot0(provider, ctx.proxy.address);

        const byte0 = parseByte(slot0, 0); // lowest-order byte
        const byte1 = parseByte(slot0, 1);

        let confirmed = false;
        let confirmationKind: 'packed-bools' | 'numeric-initialized' | undefined;
        let initializedBool = undefined as undefined | boolean;
        let initializingBool = undefined as undefined | boolean;
        let initializedNumericNonZero = undefined as undefined | boolean;

        if (logicPatterns.hasPackedBools) {
            initializedBool = byte0 !== 0;
            initializingBool = byte1 !== 0;
            // Heuristic: if either is polluted, initializer-style guards may be impacted
            if (initializedBool || initializingBool) {
                confirmed = true;
                confirmationKind = 'packed-bools';
            }
        }

        if (!confirmed && logicPatterns.hasNumericInitialized) {
            // If any non-zero in the word, consider initialized set
            const nonZero = /^0x0+$/.test(slot0) ? false : slot0 !== '0x' && slot0 !== '0x' + '0'.repeat(64);
            initializedNumericNonZero = nonZero;
            if (nonZero) {
                confirmed = true;
                confirmationKind = 'numeric-initialized';
            }
        }

        findings.push({
            id: confirmed ? 'storage-collision-confirmed' : 'storage-collision-unconfirmed',
            title: confirmed ? 'Stage2: On-chain state confirms storage collision risk' : 'Stage2: On-chain state does not confirm collision (heuristic)',
            severity: confirmed ? 'critical' : 'low',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                slot0Raw: slot0,
                byte0,
                byte1,
                confirmationKind,
                initializedBool,
                initializingBool,
                initializedNumericNonZero,
            } as any,
        });

        return findings;
    }
};



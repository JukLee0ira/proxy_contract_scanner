import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function concatSources(sources?: Record<string, string>): string {
    if (!sources) return '';
    return Object.values(sources).join('\n\n');
}

function hasConstructor(text: string): boolean {
    return /constructor\s*\([^)]*\)\s*\{/.test(text);
}

function hasDisableInitializers(text: string): boolean {
    return /_disableInitializers\s*\(/.test(text);
}

type InitFunctionInfo = { signature: string; hasInitializerModifier: boolean };
function findInitFunctions(text: string): InitFunctionInfo[] {
    const results: InitFunctionInfo[] = [];
    const regex = /function\s+((?:initialize|init\w*))\s*\([^)]*\)\s*(?:[a-zA-Z0-9_\s]*)\s*(public|external)[^{;]*\{/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const sigStart = m.index;
        const sigEnd = regex.lastIndex;
        const window = text.slice(sigStart, Math.min(text.length, sigEnd + 120));
        const hasInitializer = /\b(re?initializer)(\s*\(|\b)/i.test(window);
        results.push({ signature: m[0], hasInitializerModifier: hasInitializer });
    }
    return results;
}

function isZeroHex(hex?: string): boolean {
    if (!hex) return true;
    if (!hex.startsWith('0x')) return false;
    const clean = hex.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

function parseByte(hexWord: string, fromEndIndex: number): number {
    if (!hexWord || !hexWord.startsWith('0x')) return 0;
    const clean = hexWord.slice(2);
    const start = clean.length - (fromEndIndex + 1) * 2;
    if (start < 0) return 0;
    const byteHex = clean.slice(start, start + 2) || '00';
    return parseInt(byteHex, 16);
}

async function getStorageSlot(provider: ethers.Provider, address: string, slotHex: string): Promise<string> {
    try {
        const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
        return typeof hex === 'string' ? hex : '0x';
    } catch {
        return '0x';
    }
}

export const InitializerMistakesPairDetector: PairDetector = {
    name: 'initializer_mistakes',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];
        const logicAddr = ctx.logic.address;
        const logicSrc = concatSources(ctx.logic.sources);

        // Step 1: Static analysis (heuristic over sources)
        const constructorExists = hasConstructor(logicSrc);
        const constructorDisables = hasDisableInitializers(logicSrc);
        const initFns = findInitFunctions(logicSrc);
        const hasPublicInit = initFns.length > 0;
        const anyInitMissingModifier = initFns.some(f => !f.hasInitializerModifier);
        const uupsHints = /UUPSUpgradeable|upgradeToAndCall|proxiableUUID/.test(logicSrc);

        const staticRisky = !constructorDisables && hasPublicInit && anyInitMissingModifier;
        const staticSafe = constructorDisables || (hasPublicInit && !anyInitMissingModifier) || !hasPublicInit;

        findings.push({
            id: 'initializer-mistakes-static',
            title: staticRisky
                ? 'Initializer exposure: public initialize without initializer protection'
                : 'Initializer exposure: no public initialize detected',
            severity: staticRisky ? 'high' : 'info',
            metadata: {
                logicAddress: logicAddr,
                constructorExists,
                constructorDisables,
                hasPublicInit,
                initFunctions: initFns.slice(0, 5).map(f => ({ signature: f.signature.trim(), hasInitializerModifier: f.hasInitializerModifier })),
                uupsHints,
            } as any,
        });

        // Step 2: On-chain verification (only if static looks risky)
        if (staticRisky) {
            const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const slot0 = await getStorageSlot(provider, logicAddr, '0x0');
            const byte0 = parseByte(slot0, 0);
            const byte1 = parseByte(slot0, 1);
            const allZero = isZeroHex(slot0);

            const confirmedUninitialized = allZero || (byte0 === 0 && byte1 === 0);
            findings.push({
                id: confirmedUninitialized ? 'initializer-mistakes-onchain-confirmed' : 'initializer-mistakes-onchain-mitigated',
                title: confirmedUninitialized
                    ? 'Initializer exposure: implementation uninitialized (slot 0)'
                    : 'Initializer exposure: initialized state present (slot 0)',
                severity: confirmedUninitialized ? 'high' : 'low',
                metadata: {
                    logicAddress: logicAddr,
                    slot0,
                    byte0,
                    byte1,
                    heuristicNote: 'Slot 0 heuristic: many OZ Initializable patterns pack flags into slot 0 (_initialized/_initializing).',
                } as any,
            });
        }

        return findings;
    }
};



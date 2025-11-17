import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function concatSources(sources?: Record<string, string>): string {
    if (!sources) return '';
    return Object.values(sources).join('\n\n');
}

function isZeroHex(hex?: string): boolean {
    if (!hex) return true;
    if (!hex.startsWith('0x')) return false;
    const clean = hex.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

async function getStorageSlot(address: string, slotHex: string, provider: ethers.Provider): Promise<string> {
    try {
        const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
        return typeof hex === 'string' ? hex : '0x';
    } catch {
        return '0x';
    }
}

type BeaconPatternAnalysis = {
    isProxyLike: boolean;
    hasBeaconVar: boolean;
    hasInitFunc: boolean;
    initWritesBeacon: boolean;
    constructorSetsBeacon: boolean;
    initHasAccessControl: boolean;
    usesEip1967Beacon: boolean;
};

function analyzeBeaconInitializerPatterns(proxySourceText: string): BeaconPatternAnalysis {
    const text = proxySourceText || '';
    const lower = text.toLowerCase();

    const isProxyLike =
        lower.includes('delegatecall(') ||
        lower.includes(' delegatecall ') ||
        lower.includes('delegatecall{');

    const hasBeaconVar =
        /\baddress\s+(?:public|external|internal|private)?\s*(beacon|_beacon|beaconAddress)\b/i.test(text) ||
        lower.includes('eip1967.proxy.beacon');

    const usesEip1967Beacon =
        lower.includes('eip1967.proxy.beacon') ||
        lower.includes('_beacon_slot') ||
        lower.includes('a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50');

    const hasInitFunc =
        /function\s+initialize\s*\([^)]*\)\s*(public|external)/i.test(text) ||
        /function\s+initBeacon\s*\([^)]*\)\s*(public|external)/i.test(text);

    const initWritesBeacon =
        /function\s+initialize[\s\S]*?{[\s\S]*?beacon\s*=\s*[^;]+;/i.test(text) ||
        /function\s+initBeacon[\s\S]*?{[\s\S]*?beacon\s*=\s*[^;]+;/i.test(text);

    const constructorSetsBeacon =
        /constructor\s*\([^)]*\)[\s\S]*?{[\s\S]*?beacon\s*=\s*[^;]+;/i.test(text);

    const initHasAccessControl =
        /function\s+initialize[\s\S]*?{[\s\S]*?(onlyOwner|onlyAdmin|onlyRole|AccessControl|msg\.sender)/i.test(text) ||
        /function\s+initBeacon[\s\S]*?{[\s\S]*?(onlyOwner|onlyAdmin|onlyRole|AccessControl|msg\.sender)/i.test(text);

    return {
        isProxyLike,
        hasBeaconVar,
        hasInitFunc,
        initWritesBeacon,
        constructorSetsBeacon,
        initHasAccessControl,
        usesEip1967Beacon,
    };
}

export const MixingPatternsPairDetector: PairDetector = {
    name: 'mixing_patterns',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const proxySourceText = concatSources(ctx.proxy.sources);
        const logicSourceText = concatSources(ctx.logic.sources);
        const proxyHasSrc = proxySourceText.trim().length > 0;

        // If we have no sources for proxy, we can only emit an informational finding.
        if (!proxyHasSrc) {
            findings.push({
                id: 'mixing-patterns-no-source',
                title: 'mixing_patterns: proxy sources unavailable, skipping static initializer analysis',
                severity: 'info',
                metadata: {
                    proxyAddress: ctx.proxy.address,
                    logicAddress: ctx.logic.address,
                    notes: 'mixing_patterns detector requires verified proxy source code for static analysis.',
                } as any,
            });
            return findings;
        }

        const analysis = analyzeBeaconInitializerPatterns(proxySourceText);

        const stage1Potential =
            analysis.isProxyLike &&
            analysis.hasBeaconVar &&
            analysis.hasInitFunc &&
            analysis.initWritesBeacon &&
            !analysis.constructorSetsBeacon;

        findings.push({
            id: 'mixing-patterns-stage1',
            title: 'Beacon-style proxy initializer pattern analysis (stage 1: static)',
            severity: stage1Potential ? 'high' : 'info',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                proxyPatterns: {
                    isProxyLike: analysis.isProxyLike,
                    hasBeaconVar: analysis.hasBeaconVar,
                    hasInitFunc: analysis.hasInitFunc,
                    initWritesBeacon: analysis.initWritesBeacon,
                    constructorSetsBeacon: analysis.constructorSetsBeacon,
                    initHasAccessControl: analysis.initHasAccessControl,
                    usesEip1967Beacon: analysis.usesEip1967Beacon,
                },
                logicSummary: {
                    // We currently do not deeply inspect logic for this pattern, but include basic hints for future extensions.
                    hasSource: logicSourceText.trim().length > 0,
                },
            } as any,
        });

        // If static heuristics do not indicate the Teller-style pattern, stop here.
        if (!stage1Potential) {
            return findings;
        }

        // Stage 2: on-chain confirmation using storage slots.
        const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const EIP1967_BEACON_SLOT =
            '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

        const slotToCheck = analysis.usesEip1967Beacon ? EIP1967_BEACON_SLOT : '0x0';

        const [slotWord] = await Promise.all([
            getStorageSlot(ctx.proxy.address, slotToCheck, provider),
        ]);

        const slotIsZero = isZeroHex(slotWord);

        let confirmed = false;
        let severity: PairDetectorFinding['severity'] = 'low';
        let title: string;

        if (slotIsZero && !analysis.initHasAccessControl) {
            confirmed = true;
            severity = 'critical';
            title = 'Uninitialized beacon-style proxy with publicly callable initializer (Teller-style pattern confirmed)';
        } else if (!slotIsZero && !analysis.initHasAccessControl) {
            severity = 'medium';
            title = 'Beacon-style proxy initializer is public but on-chain beacon slot is non-zero (likely already initialized)';
        } else if (slotIsZero && analysis.initHasAccessControl) {
            severity = 'medium';
            title = 'Beacon-style proxy beacon slot is zero but initializer appears access-controlled';
        } else {
            severity = 'info';
            title = 'Beacon-style proxy initializer pattern present but mitigated by state or access control';
        }

        findings.push({
            id: confirmed ? 'mixing-patterns-confirmed' : 'mixing-patterns-state-check',
            title,
            severity,
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                slotChecked: slotToCheck,
                slotWord,
                slotIsZero,
                staticPatterns: analysis,
                notes: {
                    description:
                        'Combines static proxy initializer pattern with on-chain beacon-slot state to confirm or downgrade risk.',
                },
            } as any,
        });

        return findings;
    },
};


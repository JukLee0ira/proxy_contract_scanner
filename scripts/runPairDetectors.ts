import { analyzeContract } from '../src/services/analyzer';
import { runPairDetectors } from '../src/detectors/pair';
import { HelloPairDetector } from '../src/detectors/pair/helloPair';
import { UpgradeGovernancePairDetector } from '../src/detectors/pair/upgradeGovernance';
import { getVerifiedSource } from '../src/clients/etherscan';
import { StorageCollisionPairDetector } from '../src/detectors/pair/storageCollision';

function pickAddress(args: string[], idx: number): string | undefined {
    const pos = args.filter(a => !a.includes('='))[idx];
    if (pos && /^0x[0-9a-fA-F]{40}$/.test(pos)) return pos;
    return undefined;
}

async function main() {
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const kv: Record<string, string> = Object.fromEntries(
        args.filter(a => a.includes('=')).map(a => {
            const [k, ...rest] = a.split('=');
            return [k, rest.join('=')];
        })
    );
    const proxy = process.env.PROXY || kv['proxy'] || pickAddress(args, 0);
    const logic = process.env.LOGIC || kv['logic'] || pickAddress(args, 1);
    if (!proxy || !logic) {
        console.error('PROXY and LOGIC required. Usage: npm run detect:pair -- proxy=0xProxy logic=0xLogic OR npm run detect:pair -- 0xProxy 0xLogic');
        process.exit(1);
    }

    console.log(`[pair] Starting analysis. proxy=${proxy.toLowerCase()} logic=${logic.toLowerCase()}`);

    async function analyzeOrFetch(address: string): Promise<{ slither: any; sources?: Record<string, string> }>{
        console.log(`[pair] analyzeContract -> ${address.toLowerCase()}`);
        try {
            const analysis = await analyzeContract(address);
            if (analysis.status === 'completed' && analysis.parsed) {
                const srcCount = analysis.sources ? Object.keys(analysis.sources).length : 0;
                const nonEmpty = analysis.sources ? Object.values(analysis.sources).filter((c) => (c || '').trim().length > 0).length : 0;
                console.log(`[pair] Slither OK for ${address.toLowerCase()} | sources=${srcCount} nonEmpty=${nonEmpty}`);
                return { slither: analysis.parsed, sources: analysis.sources };
            }
            console.warn(`[pair] Slither FAILED for ${address.toLowerCase()} | reason=${analysis.rawOutput || 'no_json'} | falling back to explorer source fetch`);
        } catch (e: any) {
            console.warn(`[pair] analyzeContract threw for ${address.toLowerCase()} | ${e?.message || String(e)}`);
        }

        try {
            const verified = await getVerifiedSource(address);
            const srcCount = Object.keys(verified.sources || {}).length;
            const nonEmpty = Object.values(verified.sources || {}).filter((c) => (c || '').trim().length > 0).length;
            console.log(`[pair] Explorer source fetched for ${address.toLowerCase()} | files=${srcCount} nonEmpty=${nonEmpty}`);
            return { slither: {}, sources: verified.sources };
        } catch (e: any) {
            console.error(`[pair] Explorer source fetch FAILED for ${address.toLowerCase()} | ${e?.message || String(e)}`);
            throw e;
        }
    }

    const [proxyData, logicData] = await Promise.all([analyzeOrFetch(proxy), analyzeOrFetch(logic)]);
    const proxySrcCount = proxyData.sources ? Object.keys(proxyData.sources).length : 0;
    const logicSrcCount = logicData.sources ? Object.keys(logicData.sources).length : 0;
    const proxyNonEmpty = proxyData.sources ? Object.values(proxyData.sources).filter((c) => (c || '').trim().length > 0).length : 0;
    const logicNonEmpty = logicData.sources ? Object.values(logicData.sources).filter((c) => (c || '').trim().length > 0).length : 0;
    console.log(`[pair] Prepared contexts | proxy{ slither=${!!proxyData.slither}, sources=${proxySrcCount}, nonEmpty=${proxyNonEmpty} } | logic{ slither=${!!logicData.slither}, sources=${logicSrcCount}, nonEmpty=${logicNonEmpty} }`);

    if (proxyNonEmpty === 0 || logicNonEmpty === 0) {
        if (proxyNonEmpty === 0) console.error(`[pair] ERROR: No non-empty sources for proxy ${proxy.toLowerCase()}`);
        if (logicNonEmpty === 0) console.error(`[pair] ERROR: No non-empty sources for logic ${logic.toLowerCase()}`);
        console.error('[pair] Aborting: Both proxy and logic must have verified, non-empty sources before running pair detectors.');
        process.exit(2);
    }

    const kvDet = kv['detectors'] || process.env.DETECTORS || '';
    const detKeys = kvDet ? kvDet.split(',').map(s => s.trim()).filter(Boolean) : [];
    const registry: Record<string, any> = {
        'hello-pair': HelloPairDetector,
        'upgrade-governance': UpgradeGovernancePairDetector,
        'storage-collision': StorageCollisionPairDetector,
    };
    const selected = detKeys.length ? detKeys.map(k => registry[k]).filter(Boolean) : Object.values(registry);

    console.log(`[pair] Detectors selected: ${selected.map((d: any) => d.name || 'unknown').join(', ')}`);

    const findings = await runPairDetectors(
        {
            proxy: { address: proxy.toLowerCase(), slither: proxyData.slither, sources: proxyData.sources },
            logic: { address: logic.toLowerCase(), slither: logicData.slither, sources: logicData.sources },
        },
        selected
    );

    console.log(JSON.stringify({ proxy: proxy.toLowerCase(), logic: logic.toLowerCase(), findings }, null, 2));
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



import { analyzeContract } from '../src/services/analyzer';
import { runPairDetectors } from '../src/detectors/pair';
import { HelloPairDetector } from '../src/detectors/pair/helloPair';

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

    const [proxyAnalysis, logicAnalysis] = await Promise.all([analyzeContract(proxy), analyzeContract(logic)]);
    if (proxyAnalysis.status !== 'completed' || !proxyAnalysis.parsed) {
        console.error('Proxy analysis failed or no JSON available');
        process.exit(2);
    }
    if (logicAnalysis.status !== 'completed' || !logicAnalysis.parsed) {
        console.error('Logic analysis failed or no JSON available');
        process.exit(2);
    }

    const findings = await runPairDetectors(
        {
            proxy: { address: proxy.toLowerCase(), slither: proxyAnalysis.parsed, sources: proxyAnalysis.sources },
            logic: { address: logic.toLowerCase(), slither: logicAnalysis.parsed, sources: logicAnalysis.sources },
        },
        [HelloPairDetector]
    );

    console.log(JSON.stringify({ proxy: proxy.toLowerCase(), logic: logic.toLowerCase(), findings }, null, 2));
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



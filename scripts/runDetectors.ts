import { analyzeContract } from '../src/services/analyzer';
import { runDetectors, selectDetectors } from '../src/detectors';
import { ethers } from 'ethers';

async function main() {
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const kv: Record<string, string> = Object.fromEntries(
        args.filter(a => a.includes('=')).map(a => {
            const [k, ...rest] = a.split('=');
            return [k, rest.join('=')];
        })
    );
    const addrArg = args.find(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    const addr = process.env.ADDRESS || addrArg;
    if (!addr) {
        console.error('ADDRESS required. Usage: npm run detect:hello -- 0xYourAddress OR ADDRESS=0xYourAddress npm run detect:hello');
        process.exit(1);
    }
    const noSource = (process.env.NO_SOURCE === '1') || (kv['NO_SOURCE'] === '1') || (kv['no_source'] === '1') || (kv['no-source'] === '1');
    const detArg = process.env.DETECTORS || kv['detectors'] || '';
    const keys = detArg ? detArg.split(',').map(s => s.trim()).filter(Boolean) : [];
    const detectors = selectDetectors(keys);
    let findings;
    if (noSource) {
        const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const code = await provider.getCode(addr);
        if (!code || code === '0x') {
            console.error('No bytecode found at address (getCode returned 0x). Check RPC and address.');
            process.exit(2);
        }
        findings = await runDetectors(
            { address: addr.toLowerCase(), slither: {}, bytecode: code },
            detectors
        );
    } else {
        const analysis = await analyzeContract(addr);
        if (analysis.status !== 'completed' || !analysis.parsed) {
            console.error('Analysis failed or no JSON available');
            process.exit(2);
        }
        findings = await runDetectors(
            { address: addr.toLowerCase(), slither: analysis.parsed, sources: analysis.sources },
            detectors
        );
    }
    console.log(JSON.stringify({ address: addr.toLowerCase(), findings }, null, 2));
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



import { analyzeContract } from '../src/services/analyzer';
import { runDetectors } from '../src/detectors';
import { HelloDetector } from '../src/detectors/hello';

async function main() {
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const addr = process.env.ADDRESS || args[0];
    if (!addr) {
        console.error('ADDRESS required. Usage: npm run detect:hello -- 0xYourAddress OR ADDRESS=0xYourAddress npm run detect:hello');
        process.exit(1);
    }
    const analysis = await analyzeContract(addr);
    if (analysis.status !== 'completed' || !analysis.parsed) {
        console.error('Analysis failed or no JSON available');
        process.exit(2);
    }
    const findings = await runDetectors({ address: addr.toLowerCase(), slither: analysis.parsed }, [HelloDetector]);
    console.log(JSON.stringify({ address: addr.toLowerCase(), findings }, null, 2));
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



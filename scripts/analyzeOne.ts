import { analyzeContract } from '../src/services/analyzer';

async function main() {
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const addr = process.env.ADDRESS || args[0];
    if (!addr) {
        console.error('ADDRESS required. Usage: npm run analyze:one -- 0xYourAddress OR ADDRESS=0xYourAddress npm run analyze:one');
        process.exit(1);
    }
    const res = await analyzeContract(addr);
    console.log(res.status);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



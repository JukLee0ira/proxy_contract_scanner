import { analyzeContract } from '../src/services/analyzer';

async function main() {
    const cli = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const envList = (process.env.ADDRESSES || '').split(',').map(s => s.trim()).filter(Boolean);
    const addresses = cli.length ? cli : envList;
    if (!addresses.length) {
        console.error('No addresses provided. Usage: npm run scan:initial -- 0xaddr1 0xaddr2 ... OR set ADDRESSES=a1,a2');
        process.exit(2);
    }
    for (const address of addresses) {
        try {
            console.log(`Analyzing ${address} ...`);
            const res = await analyzeContract(address);
            console.log(`Result ${address}: ${res.status}`);
        } catch (e) {
            console.error(`Failed ${address}:`, e instanceof Error ? e.message : String(e));
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});



import { getVerifiedSource } from '../src/clients/etherscan';

async function main() {
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const addr = process.env.ADDRESS || args[0];
    if (!addr) {
        console.error('ADDRESS required. Usage: npm run print:source -- 0xYourAddress OR ADDRESS=0xYourAddress npm run print:source');
        process.exit(1);
    }
    const res = await getVerifiedSource(addr);
    console.log(`Contract: ${res.contractName}  Compiler: ${res.compilerVersion}`);
    for (const [filename, content] of Object.entries(res.sources)) {
        console.log(`\n===== ${filename} =====`);
        console.log(content);
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});



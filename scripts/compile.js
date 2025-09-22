const fs = require('fs');
const path = require('path');
const solc = require('solc');

// Contract source files
const contractsDir = path.join(__dirname, '../contracts');
const artifactsDir = path.join(__dirname, '../artifacts/contracts');

// Ensure artifacts directory exists
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Read contract source
function readContract(contractName) {
    const contractPath = path.join(contractsDir, `${contractName}.sol`);
    return fs.readFileSync(contractPath, 'utf8');
}

// Compile contracts
function compileContracts() {
    console.log('📝 Reading contract sources...');
    
    const sources = {
        'Proxy1967.sol': {
            content: readContract('Proxy1967')
        },
        'LogicV1.sol': {
            content: readContract('LogicV1')
        },
        'LogicV2.sol': {
            content: readContract('LogicV2')
        }
    };

    const input = {
        language: 'Solidity',
        sources,
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            },
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object']
                }
            }
        }
    };

    console.log('🔨 Compiling contracts...');
    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors) {
        output.errors.forEach(error => {
            if (error.severity === 'error') {
                console.error('❌ Compilation error:', error.formattedMessage);
                process.exit(1);
            } else {
                console.warn('⚠️  Warning:', error.formattedMessage);
            }
        });
    }

    // Save artifacts
    console.log('💾 Saving artifacts...');
    
    Object.keys(sources).forEach(sourceFile => {
        const contractName = path.basename(sourceFile, '.sol');
        const contract = output.contracts[sourceFile][contractName];
        
        if (contract) {
            const contractDir = path.join(artifactsDir, sourceFile);
            ensureDir(contractDir);
            
            const artifact = {
                contractName,
                abi: contract.abi,
                bytecode: '0x' + contract.evm.bytecode.object,
                deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
                sourceName: sourceFile,
                linkReferences: {},
                deployedLinkReferences: {}
            };
            
            const artifactPath = path.join(contractDir, `${contractName}.json`);
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
            

        }
    });

    console.log('🎉 Compilation completed successfully!');
}

// Run compilation
try {
    compileContracts();
} catch (error) {
    console.error('❌ Compilation failed:', error);
    process.exit(1);
}

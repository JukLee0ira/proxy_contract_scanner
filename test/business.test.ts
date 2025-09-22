import { ethers } from 'ethers';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Import scanner functions - we'll need to extract them or create interfaces
const RPC_URL = process.env.RPC_URL || "http://localhost:8547";
const DB_CONFIG = {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "mydb",
    user: process.env.DB_USER || "dbuser",
    password: process.env.DB_PASSWORD || "dbpass",
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
};

describe('Proxy Scanner Business Logic Tests', () => {
    let provider: ethers.JsonRpcProvider;
    let signer: ethers.Wallet;
    let dbPool: Pool;
    
    // Contract artifacts
    let proxyFactory: ethers.ContractFactory;
    let logicV1Factory: ethers.ContractFactory;
    let logicV2Factory: ethers.ContractFactory;
    
    // Deployed contracts
    let logicV1: any;
    let logicV2: any;
    let proxy: any;

    // Scanner functions (extracted from main file)
    function compareOpcodes(bytecode: string, targetOpcode: number): boolean {
        const cleanBytecode = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
        const bytecodeBytes: number[] = [];
        
        for (let i = 0; i < cleanBytecode.length; i += 2) {
            bytecodeBytes.push(parseInt(cleanBytecode.substr(i, 2), 16));
        }

        let i = 0;
        while (i < bytecodeBytes.length) {
            const op = bytecodeBytes[i];
            if (op >= 0x60 && op <= 0x7F) {
                const skipBytes = op - 95;
                i += skipBytes + 1;
            } else if (op === targetOpcode) {
                return true;
            } else {
                i++;
            }
        }
        return false;
    }

    async function checkBytecodeForOpcode(address: string, opcode: number): Promise<boolean> {
        try {
            const code = await provider.getCode(address);
            if (code && code !== "0x") {
                return compareOpcodes(code, opcode);
            }
            return false;
        } catch (error) {
            throw new Error(`Error checking bytecode for ${address}: ${error}`);
        }
    }

    async function getProxyStorage(proxyAddress: string) {
        const logicSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
        const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
        
        const [logicValue, adminValue] = await Promise.all([
            provider.send("eth_getStorageAt", [proxyAddress, logicSlot, "latest"]),
            provider.send("eth_getStorageAt", [proxyAddress, adminSlot, "latest"])
        ]);

        return {
            logic: logicValue,
            admin: adminValue
        };
    }

    // Helper function to clean address format
    function cleanAddress(value: string): string {
        const clean = value.startsWith('0x') ? value : '0x' + value;
        return clean.replace(/^0x0+/, '0x');
    }

    // Helper function to check if address format is valid
    function isValidAddress(addr: string): boolean {
        const match = addr.match(/^0x[0-9a-fA-F]{40}$/);
        return match !== null && addr.length === 42;
    }

    async function saveProxyToDatabase(proxyAddress: string, logicContract: string, adminContract: string = '', blockNumber: number, upgradeTxHash: string = ''): Promise<number | null> {
        const client = await dbPool.connect();
        try {
            let insertQuery = ``;
            let queryParams: any[] = [];

            // Check if record already exists (for duplicate prevention)
            const existingQuery = 'SELECT id FROM proxy_contracts WHERE proxy_address = $1 AND logic_contract = $2';
            const existingResult = await client.query(existingQuery, [proxyAddress.toLowerCase(), logicContract.toLowerCase()]);

            if (existingResult.rows.length > 0) {
                // Record already exists, return null
                return null;
            }

            if (upgradeTxHash) {
                insertQuery = `
                    INSERT INTO proxy_contracts (proxy_address, logic_contract, admin_contract, block_number, upgrade_tx_hash)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id
                `;
                queryParams = [
                    proxyAddress.toLowerCase(),
                    logicContract.toLowerCase(),
                    adminContract ? adminContract.toLowerCase() : null,
                    blockNumber,
                    upgradeTxHash
                ];
            } else {
                insertQuery = `
                    INSERT INTO proxy_contracts (proxy_address, logic_contract, admin_contract, block_number)
                    VALUES ($1, $2, $3, $4)
                    RETURNING id
                `;
                queryParams = [
                    proxyAddress.toLowerCase(),
                    logicContract.toLowerCase(),
                    adminContract ? adminContract.toLowerCase() : null,
                    blockNumber
                ];
            }

            const result = await client.query(insertQuery, queryParams);
            return result.rows.length > 0 ? result.rows[0].id : null;
        } finally {
            client.release();
        }
    }

    async function getProxyFromDatabase(proxyAddress: string, logicContract?: string) {
        const client = await dbPool.connect();
        try {
            let query = 'SELECT * FROM proxy_contracts WHERE proxy_address = $1';
            let params = [proxyAddress.toLowerCase()];
            
            if (logicContract) {
                query += ' AND logic_contract = $2';
                params.push(logicContract.toLowerCase());
            }
            
            query += ' ORDER BY detected_at DESC';
            
            const result = await client.query(query, params);
            return result.rows;
        } finally {
            client.release();
        }
    }

    beforeAll(async () => {
        // Initialize provider and signer
        provider = new ethers.JsonRpcProvider(RPC_URL);
        
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY not found in environment variables');
        }
        
        signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        
        // Initialize database
        dbPool = new Pool(DB_CONFIG);
        
        // Create tables if not exist
        const client = await dbPool.connect();
        try {
            // Drop table if exists and recreate for testing
            await client.query(`DROP TABLE IF EXISTS proxy_contracts`);
            
            await client.query(`
                CREATE TABLE proxy_contracts (
                    id SERIAL PRIMARY KEY,
                    proxy_address VARCHAR(42) NOT NULL,
                    logic_contract VARCHAR(42),
                    admin_contract VARCHAR(42),
                    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    block_number BIGINT,
                    contract_type VARCHAR(50) DEFAULT 'unknown',
                    upgrade_tx_hash VARCHAR(66)
                )
            `);
            
            // Create index for faster queries
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_proxy_contracts_proxy ON proxy_contracts(proxy_address)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_proxy_contracts_logic ON proxy_contracts(logic_contract)
            `);
            console.log('📄 Database tables ready');
        } finally {
            client.release();
        }

        // Import contract artifacts directly
        const Proxy1967Artifact = require('../artifacts/contracts/Proxy1967.sol/Proxy1967.json');
        const LogicV1Artifact = require('../artifacts/contracts/LogicV1.sol/LogicV1.json');
        const LogicV2Artifact = require('../artifacts/contracts/LogicV2.sol/LogicV2.json');
        
        proxyFactory = new ethers.ContractFactory(Proxy1967Artifact.abi, Proxy1967Artifact.bytecode, signer);
        logicV1Factory = new ethers.ContractFactory(LogicV1Artifact.abi, LogicV1Artifact.bytecode, signer);
        logicV2Factory = new ethers.ContractFactory(LogicV2Artifact.abi, LogicV2Artifact.bytecode, signer);
        
        console.log('🔨 Contract factories created');
    });

    afterAll(async () => {
        if (dbPool) {
            await dbPool.end();
        }
    });

    describe('1. Proxy Contract Detection', () => {
        beforeAll(async () => {
            // Deploy logic contracts
            logicV1 = await logicV1Factory.connect(signer).deploy();
            await logicV1.waitForDeployment();
            
            logicV2 = await logicV2Factory.connect(signer).deploy();
            await logicV2.waitForDeployment();
            
            // Deploy proxy contract
            proxy = await proxyFactory.connect(signer).deploy(await logicV1.getAddress());
            await proxy.waitForDeployment();
            
            console.log(`🚀 Deployed contracts:`);
            console.log(`   LogicV1: ${await logicV1.getAddress()}`);
            console.log(`   LogicV2: ${await logicV2.getAddress()}`);
            console.log(`   Proxy: ${await proxy.getAddress()}`);
        });

        test('should detect proxy contract by DELEGATECALL bytecode', async () => {
            const DELEGATECALL_OPCODE = 0xf4;
            const proxyAddress = await proxy.getAddress();
            
            // Test bytecode detection
            const hasDelegateCall = await checkBytecodeForOpcode(proxyAddress, DELEGATECALL_OPCODE);
            
            expect(hasDelegateCall).toBe(true);
            console.log(`✅ Proxy contract ${proxyAddress} contains DELEGATECALL: ${hasDelegateCall}`);
        });

        test('should verify logic contract does not contain DELEGATECALL', async () => {
            const DELEGATECALL_OPCODE = 0xf4;
            const logicAddress = await logicV1.getAddress();
            
            // Logic contracts should not contain DELEGATECALL
            const hasDelegateCall = await checkBytecodeForOpcode(logicAddress, DELEGATECALL_OPCODE);
            
            expect(hasDelegateCall).toBe(false);
            console.log(`✅ Logic contract ${logicAddress} does not contain DELEGATECALL: ${hasDelegateCall}`);
        });

        test('should extract proxy and logic contract addresses from storage', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicAddress = await logicV1.getAddress();
            
            // Get storage values
            const storage = await getProxyStorage(proxyAddress);
            
            // Clean and validate addresses
            const logicStorageValue = cleanAddress(storage.logic);
            const adminStorageValue = cleanAddress(storage.admin);
            
            expect(isValidAddress(logicStorageValue)).toBe(true);
            expect(logicStorageValue.toLowerCase()).toBe(logicAddress.toLowerCase());
            
            console.log(`✅ Proxy ${proxyAddress}:`);
            console.log(`   Logic contract: ${logicStorageValue}`);
            console.log(`   Admin: ${adminStorageValue}`);
        });
    });

    describe('2. Database Integration', () => {
        test('should save proxy contract to database correctly', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicAddress = await logicV1.getAddress();
            const blockNumber = await provider.getBlockNumber();
            
            // Save to database
            const insertedId = await saveProxyToDatabase(proxyAddress, logicAddress, '', blockNumber);
            
            expect(insertedId).toBeTruthy();
            console.log(`✅ Saved proxy contract to database with ID: ${insertedId}`);
            
            // Verify data in database
            const savedRecords = await getProxyFromDatabase(proxyAddress, logicAddress);
            
            expect(savedRecords).toHaveLength(1);
            expect(savedRecords[0].proxy_address).toBe(proxyAddress.toLowerCase());
            expect(savedRecords[0].logic_contract).toBe(logicAddress.toLowerCase());
            expect(savedRecords[0].block_number).toBe(blockNumber.toString());
            
            console.log(`✅ Verified proxy contract data in database`);
        });

        test('should handle duplicate proxy contracts correctly', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicAddress = await logicV1.getAddress();
            const blockNumber = await provider.getBlockNumber();
            
            // Try to save the same proxy again
            const duplicateId = await saveProxyToDatabase(proxyAddress, logicAddress, '', blockNumber);
            
            // Should not insert duplicate
            expect(duplicateId).toBeNull();
            console.log(`✅ Correctly handled duplicate proxy contract`);
        });
    });

    describe('3. Upgrade Event Detection', () => {
        test('should detect upgrade event when proxy is upgraded', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicV2Address = await logicV2.getAddress();
            
            // Set up event listener
            const upgradeEvents: any[] = [];
            
            proxy.on('Upgraded', (newImplementation, event) => {
                upgradeEvents.push({
                    newImplementation,
                    transactionHash: event.log.transactionHash,
                    blockNumber: event.log.blockNumber
                });
            });
            
            // Perform upgrade
            const upgradeTx = await proxy.connect(signer).upgrade(logicV2Address);
            const receipt = await upgradeTx.wait();
            
            // Wait a bit for event processing
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            expect(upgradeEvents).toHaveLength(1);
            expect(upgradeEvents[0].newImplementation.toLowerCase()).toBe(logicV2Address.toLowerCase());
            expect(upgradeEvents[0].transactionHash).toBe(receipt?.hash);
            
            console.log(`✅ Detected upgrade event:`);
            console.log(`   New implementation: ${upgradeEvents[0].newImplementation}`);
            console.log(`   Transaction hash: ${upgradeEvents[0].transactionHash}`);
            console.log(`   Block number: ${upgradeEvents[0].blockNumber}`);
            
            // Verify storage has been updated
            const storage = await getProxyStorage(proxyAddress);
            const newLogicAddress = cleanAddress(storage.logic);
            
            expect(newLogicAddress.toLowerCase()).toBe(logicV2Address.toLowerCase());
            console.log(`✅ Storage updated to new logic contract: ${newLogicAddress}`);
        });

        test('should verify proxy functionality after upgrade', async () => {
            const proxyAddress = await proxy.getAddress();
            
            // Create interface to interact with proxy as LogicV2
            const proxyAsLogicV2 = logicV2Factory.attach(proxyAddress).connect(signer);
            
            // Test new functionality (add method only exists in V2)
            await (proxyAsLogicV2 as any).setX(100);
            await (proxyAsLogicV2 as any).add(50);
            
            const newX = await (proxyAsLogicV2 as any).x();
            expect(newX).toBe(150n);
            
            const version = await (proxyAsLogicV2 as any).version();
            expect(version).toBe("V2");
            
            console.log(`✅ Proxy functionality verified after upgrade:`);
            console.log(`   X value: ${newX}`);
            console.log(`   Version: ${version}`);
        });
    });

    describe('4. Upgrade Event Database Integration', () => {
        test('should save upgrade event to database', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicV2Address = await logicV2.getAddress();
            
            // Get the upgrade transaction details
            const filter = proxy.filters.Upgraded();
            const events = await proxy.queryFilter(filter);
            const upgradeEvent = events[events.length - 1]; // Get latest upgrade event
            
            const blockNumber = upgradeEvent.blockNumber;
            const txHash = upgradeEvent.transactionHash;
            
            // Save upgrade event to database
            const insertedId = await saveProxyToDatabase(
                proxyAddress,
                logicV2Address,
                '',
                blockNumber,
                txHash
            );
            
            expect(insertedId).toBeTruthy();
            console.log(`✅ Saved upgrade event to database with ID: ${insertedId}`);
            
            // Verify upgrade event in database
            const savedRecords = await getProxyFromDatabase(proxyAddress);
            
            // Should have 2 records now (original + upgrade)
            expect(savedRecords.length).toBeGreaterThanOrEqual(2);
            
            // Find the upgrade record
            const upgradeRecord = savedRecords.find(record => 
                record.logic_contract === logicV2Address.toLowerCase() && 
                record.upgrade_tx_hash === txHash
            );
            
            expect(upgradeRecord).toBeTruthy();
            expect(upgradeRecord.upgrade_tx_hash).toBe(txHash);
            expect(upgradeRecord.block_number).toBe(blockNumber.toString());
            
            console.log(`✅ Verified upgrade event in database:`);
            console.log(`   Proxy: ${upgradeRecord.proxy_address}`);
            console.log(`   New logic: ${upgradeRecord.logic_contract}`);
            console.log(`   Tx hash: ${upgradeRecord.upgrade_tx_hash}`);
            console.log(`   Block: ${upgradeRecord.block_number}`);
        });

        test('should track upgrade history correctly', async () => {
            const proxyAddress = await proxy.getAddress();
            const logicV1Address = await logicV1.getAddress();
            const logicV2Address = await logicV2.getAddress();
            
            // Get all records for this proxy
            const allRecords = await getProxyFromDatabase(proxyAddress);
            
            expect(allRecords.length).toBeGreaterThanOrEqual(2);
            
            // Verify we have records for both logic contracts
            const logicV1Record = allRecords.find(r => r.logic_contract === logicV1Address.toLowerCase());
            const logicV2Record = allRecords.find(r => r.logic_contract === logicV2Address.toLowerCase());
            
            expect(logicV1Record).toBeTruthy();
            expect(logicV2Record).toBeTruthy();
            
            // V2 record should have upgrade_tx_hash, V1 should not
            expect(logicV1Record.upgrade_tx_hash).toBeFalsy();
            expect(logicV2Record.upgrade_tx_hash).toBeTruthy();
            
            console.log(`✅ Upgrade history tracked correctly:`);
            console.log(`   Total records: ${allRecords.length}`);
            console.log(`   V1 deployment: ${logicV1Record.detected_at}`);
            console.log(`   V2 upgrade: ${logicV2Record.detected_at}`);
        });
    });

    describe('5. End-to-End Scanner Simulation', () => {
        test('should simulate complete scanner workflow', async () => {
            // Simulate discovering a new proxy contract in a block
            const proxyAddress = await proxy.getAddress();
            const currentBlock = await provider.getBlockNumber();
            
            console.log(`🔍 Simulating scanner workflow for block ${currentBlock}`);
            
            // Step 1: Check if address contains DELEGATECALL
            const DELEGATECALL_OPCODE = 0xf4;
            const hasDelegateCall = await checkBytecodeForOpcode(proxyAddress, DELEGATECALL_OPCODE);
            
            if (hasDelegateCall) {
                console.log(`✅ Step 1: Found DELEGATECALL in ${proxyAddress}`);
                
                // Step 2: Extract storage values
                const storage = await getProxyStorage(proxyAddress);
                const logicAddress = cleanAddress(storage.logic);
                const adminAddress = cleanAddress(storage.admin);
                
                if (isValidAddress(logicAddress)) {
                    console.log(`✅ Step 2: Extracted logic contract: ${logicAddress}`);
                    
                    // Step 3: Save to database
                    const insertedId = await saveProxyToDatabase(
                        proxyAddress,
                        logicAddress,
                        isValidAddress(adminAddress) ? adminAddress : '',
                        currentBlock
                    );
                    
                    if (insertedId) {
                        console.log(`✅ Step 3: Saved to database with ID: ${insertedId}`);
                    } else {
                        console.log(`ℹ️  Step 3: Already exists in database`);
                    }
                    
                    // Step 4: Verify data integrity
                    const savedRecords = await getProxyFromDatabase(proxyAddress, logicAddress);
                    expect(savedRecords).toHaveLength(1);
                    
                    console.log(`✅ Step 4: Verified data integrity`);
                    console.log(`✅ Scanner workflow completed successfully!`);
                } else {
                    console.log(`❌ Step 2: Invalid logic contract address: ${logicAddress}`);
                }
            } else {
                console.log(`ℹ️  Step 1: No DELEGATECALL found in ${proxyAddress}`);
            }
        });
    });
});

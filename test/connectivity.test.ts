import { ethers } from 'ethers';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Test configuration
const RPC_URL = process.env.RPC_URL || "http://localhost:8547";
const DB_CONFIG = {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "mydb_test",
    user: process.env.DB_USER || "dbuser",
    password: process.env.DB_PASSWORD || "dbpass",
    max: 3,
    min: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    acquireTimeoutMillis: 10000,
    allowExitOnIdle: true,
};

describe('Proxy Scanner Connectivity Tests', () => {
    let provider: JsonRpcProvider;
    let dbPool: Pool | null = null;

    beforeAll(() => {
        provider = new JsonRpcProvider(RPC_URL);
    });

    afterAll(async () => {
        if (dbPool) {
            await dbPool.end();
        }
    });

    describe('RPC Node Connection', () => {
        test('should connect to RPC node and retrieve network info', async () => {
            const network = await provider.getNetwork();
            
            expect(network).toBeDefined();
            expect(typeof network.chainId).toBe('number');
            expect(Number(network.chainId)).toBeGreaterThan(0);
            

        });
    });

    describe('Database Connection', () => {
        beforeEach(() => {
            dbPool = new Pool(DB_CONFIG);
        });

        afterEach(async () => {
            if (dbPool) {
                await dbPool.end();
                dbPool = null;
            }
        });

        test('should connect to PostgreSQL database', async () => {
            const client = await dbPool!.connect();
            
            expect(client).toBeDefined();
            
            const result = await client.query('SELECT NOW() as current_time');
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].current_time).toBeInstanceOf(Date);
            

            
            client.release();
        });

        test('should retrieve PostgreSQL version info', async () => {
            const client = await dbPool!.connect();
            
            const result = await client.query('SELECT version() as postgres_version');
            const version = result.rows[0].postgres_version;
            
            expect(version).toContain('PostgreSQL');
            

            
            client.release();
        });

        test('should create and manage test tables', async () => {
            const client = await dbPool!.connect();
            
            // Create test table
            await client.query(`
                CREATE TABLE IF NOT EXISTS proxy_contracts_test (
                    id SERIAL PRIMARY KEY,
                    test_field VARCHAR(50),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Insert test data
            const insertResult = await client.query(`
                INSERT INTO proxy_contracts_test (test_field) VALUES ('jest_test') RETURNING id
            `);
            
            expect(insertResult.rows).toHaveLength(1);
            expect(insertResult.rows[0].id).toBeGreaterThan(0);
            
            // Query test data
            const selectResult = await client.query(`
                SELECT COUNT(*) as count FROM proxy_contracts_test WHERE test_field = 'jest_test'
            `);
            
            expect(parseInt(selectResult.rows[0].count)).toBeGreaterThan(0);
            
            // Cleanup
            await client.query(`DROP TABLE IF EXISTS proxy_contracts_test`);
            

            
            client.release();
        });

    });

    describe('Bytecode Analysis Functions', () => {
        // Replicate core bytecode analysis functions for testing
        function skipPush(pushOp: number): number {
            return pushOp - 95;
        }

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
                    const skipBytes = skipPush(op);
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

        test('should parse bytecode correctly', () => {
            // Test with simple bytecode containing DELEGATECALL (0xf4)
            const testBytecode = "0x6060604052600a6060f4"; // Contains DELEGATECALL
            const hasDelegateCall = compareOpcodes(testBytecode, 0xf4);
            
            expect(hasDelegateCall).toBe(true);
            

        });

        test('should check bytecode for DELEGATECALL opcode', async () => {
            const DELEGATECALL_OPCODE = 0xf4;
            const emptyAddress = "0x0000000000000000000000000000000000000000";
            
            const result = await checkBytecodeForOpcode(emptyAddress, DELEGATECALL_OPCODE);
            
            expect(typeof result).toBe('boolean');
            expect(result).toBe(false); // Empty address should not have DELEGATECALL
            

        });


        test('should test EIP-1967 storage slot queries', async () => {
            const logicSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
            const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
            const testAddress = "0x1000000000000000000000000000000000000000";
            
            const logicValue = await provider.send("eth_getStorageAt", [testAddress, logicSlot, "latest"]);
            const adminValue = await provider.send("eth_getStorageAt", [testAddress, adminSlot, "latest"]);
            
            expect(typeof logicValue).toBe('string');
            expect(typeof adminValue).toBe('string');
            expect(logicValue).toMatch(/^0x/);
            expect(adminValue).toMatch(/^0x/);
            

        });
    });
});

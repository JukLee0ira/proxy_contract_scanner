import { expect } from "chai";
import { ethers } from "hardhat";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

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

// Helpers -----------------------------------------------------------
function compareOpcodes(bytecode: string, targetOpcode: number): boolean {
    const cleanBytecode = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
    const bytecodeBytes: number[] = [];
    for (let i = 0; i < cleanBytecode.length; i += 2) {
        bytecodeBytes.push(parseInt(cleanBytecode.substr(i, 2), 16));
    }
    let i = 0;
    while (i < bytecodeBytes.length) {
        const op = bytecodeBytes[i];
        if (op >= 0x60 && op <= 0x7f) {
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
    const code = await ethers.provider.getCode(address);
    if (code && code !== "0x") {
        return compareOpcodes(code, opcode);
    }
    return false;
}

async function getProxyStorage(proxyAddress: string) {
    const logicSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const [logicValue, adminValue] = await Promise.all([
        ethers.provider.send("eth_getStorageAt", [proxyAddress, logicSlot, "latest"]),
        ethers.provider.send("eth_getStorageAt", [proxyAddress, adminSlot, "latest"]) 
    ]);
    return { logic: logicValue, admin: adminValue };
}

function cleanAddress(value: string): string {
    const input = value || '';
    const hex = input.startsWith('0x') ? input.slice(2) : input;
    const normalized = hex.padStart(64, '0');
    const last40 = normalized.slice(-40);
    return '0x' + last40;
}

function isValidAddress(addr: string): boolean {
    const match = addr.match(/^0x[0-9a-fA-F]{40}$/);
    return match !== null && addr.length === 42;
}

function toTxHash(input: string): string {
    const anyEthers: any = ethers as any;
    const keccak = anyEthers.keccak256 ?? anyEthers.utils?.keccak256;
    const toUtf8Bytes = anyEthers.toUtf8Bytes ?? anyEthers.utils?.toUtf8Bytes;
    return keccak(toUtf8Bytes(input));
}

async function saveProxyToDatabase(
    dbPool: Pool,
    proxyAddress: string,
    logicContract: string,
    adminContract: string = '',
    blockNumber: number,
    upgradeTxHash: string = ''
): Promise<number | null> {
    const client = await dbPool.connect();
    try {
        let insertQuery = ``;
        let queryParams: any[] = [];
        const existingQuery = 'SELECT id FROM proxy_contracts WHERE proxy_address = $1 AND logic_contract = $2';
        const existingResult = await client.query(existingQuery, [proxyAddress.toLowerCase(), logicContract.toLowerCase()]);
        if (existingResult.rows.length > 0) {
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

async function getProxyFromDatabase(dbPool: Pool, proxyAddress: string, logicContract?: string) {
    const client = await dbPool.connect();
    try {
        let query = 'SELECT * FROM proxy_contracts WHERE proxy_address = $1';
        const params: any[] = [proxyAddress.toLowerCase()];
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

// Tests ------------------------------------------------------------
describe('Proxy Scanner Business Logic (Hardhat)', function () {
    let dbPool: Pool;
    let proxy: any;
    let logicV1: any;
    let logicV2: any;
    let logicV1Factory: any;
    let logicV2Factory: any;
    let proxyFactory: any;

    before(async () => {
        if (!process.env.PRIVATE_KEY) {
            // 在 Hardhat 本地网络下不强制要求 PRIVATE_KEY
        }
        dbPool = new Pool(DB_CONFIG);
        const client = await dbPool.connect();
        try {
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
            await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_contracts_proxy ON proxy_contracts(proxy_address)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_contracts_logic ON proxy_contracts(logic_contract)`);
        } finally {
            client.release();
        }

        logicV1Factory = await ethers.getContractFactory('LogicV1');
        logicV2Factory = await ethers.getContractFactory('LogicV2');
        proxyFactory = await ethers.getContractFactory('Proxy1967');
    });

    after(async () => {
        if (dbPool) {
            await dbPool.end();
        }
    });

    describe('1. 部署与字节码检测', () => {
        before(async () => {
            logicV1 = await logicV1Factory.deploy();
            await (logicV1 as any).deployed?.();
            logicV2 = await logicV2Factory.deploy();
            await (logicV2 as any).deployed?.();

            const logicV1Address = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            proxy = await proxyFactory.deploy(logicV1Address);
            await (proxy as any).deployed?.();
        });

        it('应通过 DELEGATECALL 识别代理合约', async () => {
            const DELEGATECALL = 0xf4;
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const hasDelegateCall = await checkBytecodeForOpcode(proxyAddress, DELEGATECALL);
            expect(hasDelegateCall).to.equal(true);
        });


        it('应从存储槽读取逻辑与管理员地址', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicAddress = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            const storage = await getProxyStorage(proxyAddress);
            const logicStorageValue = cleanAddress(storage.logic);
            const adminStorageValue = cleanAddress(storage.admin);
            expect(isValidAddress(logicStorageValue)).to.equal(true);
            expect(logicStorageValue.toLowerCase()).to.equal(logicAddress.toLowerCase());
        });
    });

    describe('2. 数据库集成', () => {
        it('应正确保存代理记录到数据库', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicAddress = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            const blockNumber = await ethers.provider.getBlockNumber();
            const insertedId = await saveProxyToDatabase(dbPool, proxyAddress, logicAddress, '', blockNumber);
            expect(!!insertedId).to.equal(true);
            const savedRecords = await getProxyFromDatabase(dbPool, proxyAddress, logicAddress);
            expect(savedRecords).to.have.length(1);
            expect(savedRecords[0].proxy_address).to.equal(proxyAddress.toLowerCase());
            expect(savedRecords[0].logic_contract).to.equal(logicAddress.toLowerCase());
            expect(savedRecords[0].block_number).to.equal(blockNumber.toString());
        });

        it('应正确处理重复插入', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicAddress = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            const blockNumber = await ethers.provider.getBlockNumber();
            const duplicateId = await saveProxyToDatabase(dbPool, proxyAddress, logicAddress, '', blockNumber);
            expect(duplicateId).to.equal(null);
        });
    });

    describe('3. 升级事件检测与功能验证', () => {
        it('应在升级时捕获 Upgraded 事件并校验存储', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicV2Address = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());
            const upgradeEvents: any[] = [];
            (proxy as any).on('Upgraded', (newImplementation: string, event: any) => {
                upgradeEvents.push({
                    newImplementation,
                    transactionHash: (event?.log?.transactionHash ?? event?.transactionHash),
                    blockNumber: (event?.log?.blockNumber ?? event?.blockNumber)
                });
            });
            const tx = await (proxy as any).upgrade(logicV2Address);
            const receipt = await tx.wait();
            await new Promise(r => setTimeout(r, 800));
            expect(upgradeEvents).to.have.length(1);
            expect(upgradeEvents[0].newImplementation.toLowerCase()).to.equal(logicV2Address.toLowerCase());
            expect(upgradeEvents[0].transactionHash).to.not.be.undefined;
            expect(upgradeEvents[0].transactionHash).to.equal(receipt?.hash);
            const storage = await getProxyStorage(proxyAddress);
            const newLogicAddress = cleanAddress(storage.logic);
            expect(newLogicAddress.toLowerCase()).to.equal(logicV2Address.toLowerCase());
        });

        it('应在升级后通过代理正确调用 V2 功能', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const proxyAsLogicV2 = logicV2Factory.attach(proxyAddress);
            const tx1 = await (proxyAsLogicV2 as any).setX(100);
            await tx1.wait();
            const tx2 = await (proxyAsLogicV2 as any).add(50);
            await tx2.wait();
            const newX = await (proxyAsLogicV2 as any).x();
            expect(newX.toString()).to.equal("150");
            const version = await (proxyAsLogicV2 as any).version();
            expect(version).to.equal("V2");
        });
    });

    describe('4. 升级事件入库与历史追踪', () => {
        it('应将升级事件保存至数据库', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicV2Address = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());
            
            // Get current block number and simulate upgrade event data
            const currentBlock = await ethers.provider.getBlockNumber();
            
            // Create a mock transaction hash for testing purposes (32-byte keccak hash)
            const mockTxHash = toTxHash(`upgrade_${proxyAddress}_${logicV2Address}_${currentBlock}`);
            
            // Save the upgrade event to database
            const insertedId = await saveProxyToDatabase(dbPool, proxyAddress, logicV2Address, '', currentBlock, mockTxHash);
            expect(!!insertedId).to.equal(true);
            
            // Verify the record was saved
            const savedRecords = await getProxyFromDatabase(dbPool, proxyAddress);
            expect(savedRecords.length).to.be.greaterThanOrEqual(2);
            
            const upgradeRecord = savedRecords.find((r: any) => r.logic_contract === logicV2Address.toLowerCase() && r.upgrade_tx_hash === mockTxHash);
            expect(!!upgradeRecord).to.equal(true);
            expect(upgradeRecord.upgrade_tx_hash).to.equal(mockTxHash);
            expect(upgradeRecord.block_number).to.equal(currentBlock.toString());
        });

        it('应能追踪升级历史', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const logicV1Address = (logicV1 as any).address ?? (await (logicV1 as any).getAddress());
            const logicV2Address = (logicV2 as any).address ?? (await (logicV2 as any).getAddress());
            
            // Ensure we have both records in the database
            // First, check if V1 record exists, if not create it
            const existingV1Records = await getProxyFromDatabase(dbPool, proxyAddress, logicV1Address);
            if (existingV1Records.length === 0) {
                const currentBlock = await ethers.provider.getBlockNumber();
                await saveProxyToDatabase(dbPool, proxyAddress, logicV1Address, '', currentBlock);
            }
            
            // Check if V2 record exists, if not create it with upgrade hash
            const existingV2Records = await getProxyFromDatabase(dbPool, proxyAddress, logicV2Address);
            if (existingV2Records.length === 0) {
                const currentBlock = await ethers.provider.getBlockNumber();
                const mockTxHash = toTxHash(`upgrade_${proxyAddress}_${logicV2Address}_${currentBlock}`);
                await saveProxyToDatabase(dbPool, proxyAddress, logicV2Address, '', currentBlock, mockTxHash);
            }
            
            // Now check the full history
            const allRecords = await getProxyFromDatabase(dbPool, proxyAddress);
            expect(allRecords.length).to.be.greaterThanOrEqual(2);
            
            const logicV1Record = allRecords.find((r: any) => r.logic_contract === logicV1Address.toLowerCase());
            const logicV2Record = allRecords.find((r: any) => r.logic_contract === logicV2Address.toLowerCase());
            
            expect(!!logicV1Record).to.equal(true);
            expect(!!logicV2Record).to.equal(true);
            
            // V1 should not have upgrade_tx_hash (original deployment)
            expect(logicV1Record.upgrade_tx_hash).to.be.null;
            
            // V2 should have upgrade_tx_hash (upgrade event)
            expect(!!logicV2Record.upgrade_tx_hash).to.equal(true);
        });
    });

    describe('5. 端到端扫描流程模拟', () => {
        it('应完成扫描、解析、入库与校验', async () => {
            const proxyAddress = (proxy as any).address ?? (await (proxy as any).getAddress());
            const currentBlock = await ethers.provider.getBlockNumber();
            const DELEGATECALL = 0xf4;
            const hasDelegateCall = await checkBytecodeForOpcode(proxyAddress, DELEGATECALL);
            if (hasDelegateCall) {
                const storage = await getProxyStorage(proxyAddress);
                const logicAddress = cleanAddress(storage.logic);
                const adminAddress = cleanAddress(storage.admin);
                if (isValidAddress(logicAddress)) {
                    const insertedId = await saveProxyToDatabase(
                        dbPool,
                        proxyAddress,
                        logicAddress,
                        isValidAddress(adminAddress) ? adminAddress : '',
                        currentBlock
                    );
                    const savedRecords = await getProxyFromDatabase(dbPool, proxyAddress, logicAddress);
                    expect(savedRecords).to.have.length(1);
                } else {
                    throw new Error(`Invalid logic contract address: ${logicAddress}`);
                }
            } else {
                throw new Error(`No DELEGATECALL found in ${proxyAddress}`);
            }
        });
    });
});



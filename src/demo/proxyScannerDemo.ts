const { ethers } = require("ethers");
const { Pool } = require("pg");
const dotenv = require("dotenv");
import { isTelegramEnabled, buildUpgradeAlertMessage, sendTelegramAlert } from "../alert/telegram";
import { analyzeContract } from "../services/analyzer";
import { getVerifiedSource } from "../clients/etherscan";
import { runPairDetectors } from "../detectors/pair";
import { UpgradeGovernancePairDetector } from "../detectors/pair/upgradeGovernance";
import { StorageCollisionPairDetector } from "../detectors/pair/storageCollision";
import { InitializerMistakesPairDetector } from "../detectors/pair/initializerMistakes";
import { MixingPatternsPairDetector } from "../detectors/pair/mixingPatterns";
import { LibraryMisusePairDetector } from "../detectors/pair/libraryMisuse";

// TypeScript type declarations for CommonJS imports
type EthersType = {
    JsonRpcProvider: any;
    id: (signature: string) => string;
    getAddress: (address: string) => string;
};

// Load environment variables from .env file
dotenv.config();

// Concurrency control configuration
const CONCURRENCY_CONFIG = {
    MAX_CONCURRENT_BLOCKS: 3,     // Maximum number of blocks to process simultaneously
    MAX_CONCURRENT_STORAGE_QUERIES: 5,  // Maximum concurrency for batch storage queries
    BATCH_SIZE: 10,               // Queue batch consumption size
    QUEUE_PROCESS_INTERVAL: 1000  // Queue processing interval (ms)
};


const RPC_URL = process.env.RPC_URL || "http://localhost:8547";

// Simple sleep helper for async backoff
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// PostgreSQL configuration
const DB_CONFIG = {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "mydb",
    user: process.env.DB_USER || "dbuser",
    password: process.env.DB_PASSWORD || "dbpass",
    max: 10, // Reduced maximum number of clients in the pool
    min: 2,  // Minimum number of clients in the pool
    idleTimeoutMillis: 60000, // Increased idle timeout (60 seconds)
    connectionTimeoutMillis: 10000, // Increased connection timeout (10 seconds)
    acquireTimeoutMillis: 60000, // Added acquire timeout (60 seconds)
    allowExitOnIdle: true, // Allow pool to exit when idle
};

// Database availability flag
let isDatabaseAvailable = false;

const WS_URL = process.env.WS_URL || process.env.WEBSOCKET_URL || process.env.WEBSOCKET_ENDPOINT || process.env.WS_ENDPOINT;
let provider: any;
if (WS_URL) {
    try {
        provider = new (ethers as any).WebSocketProvider(WS_URL);
        console.log(`Using WebSocket provider for events: ${WS_URL}`);
    } catch (e) {
        console.warn(`Failed to init WebSocket provider, fallback to HTTP: ${e instanceof Error ? e.message : String(e)}`);
        provider = new (ethers as any).JsonRpcProvider(RPC_URL);
    }
} else {
    provider = new (ethers as any).JsonRpcProvider(RPC_URL);
}

// PostgreSQL connection pool (only create if database is available)
let pool: any = null;

// Proxy contract address queue with block number
interface ProxyQueueItem {
    address: string;
    blockNumber: number;
}
const proxyAddressQueue: ProxyQueueItem[] = [];

// Global proxy event listener instance
let proxyEventListener: ProxyEventListener | null = null;

// Global storage slot monitor instance for non-EIP1967 proxies
let storageSlotMonitor: StorageSlotMonitor | null = null;

// Pair detector registry and aliases
const PAIR_DETECTOR_REGISTRY: Record<string, any> = {
    'upgrade-governance': UpgradeGovernancePairDetector,
    'storage-collision': StorageCollisionPairDetector,
    'initializer_mistakes': InitializerMistakesPairDetector,
    'mixing_patterns': MixingPatternsPairDetector,
    // library-misuse: 单一入口；内部优先源码分析，缺源码时自动降级为 NO_SOURCE/bytecode 分析
    'library_misuse': LibraryMisusePairDetector,
    'library-misuse': LibraryMisusePairDetector,
};
const PAIR_DETECTOR_ALIASES: Record<string, string> = {
    'upgrade_governance': 'upgrade-governance',
    'storage_collision': 'storage-collision',
    'initializer-mistakes': 'initializer_mistakes',
    'initializerMistakes': 'initializer_mistakes',
    'uninitialized-impl': 'initializer_mistakes',
    'uninitialized_impl': 'initializer_mistakes',
    'uninitialized': 'initializer_mistakes',
    'admin-privilege': 'upgrade-governance',
    'mixing-patterns': 'mixing_patterns',
    'mixingPatterns': 'mixing_patterns',
    // library-misuse aliases
    'libraryMisuse': 'library_misuse',
};

function selectPairDetectors(keys?: string[]): any[] {
    const rawList: any[] =
        !keys || keys.length === 0
            ? Object.values(PAIR_DETECTOR_REGISTRY)
            : keys
                  .map(k => (PAIR_DETECTOR_ALIASES[k] || k))
                  .map(k => PAIR_DETECTOR_REGISTRY[k])
                  .filter(Boolean);

    // 去重：避免同一个 detector 通过多个 key/alias 被添加多次
    const unique: any[] = [];
    const seen = new Set<any>();
    for (const det of rawList) {
        if (!seen.has(det)) {
            seen.add(det);
            unique.push(det);
        }
    }
    return unique.length ? unique : Object.values(PAIR_DETECTOR_REGISTRY);
}

// Global analyze mode flags for event-triggered analysis
let analyzeModeEnabled: boolean = false;
let selectedPairCheckKeys: string[] = [];

// Event listener management for proxy contracts
class ProxyEventListener {
    private listeners: Map<string, any> = new Map(); // proxyAddress -> listener
    private provider: any;
    private upgradeEventSignature: string;
    private maxListeners: number;

    constructor(provider: any, maxListeners: number = 100) {
        this.provider = provider;
        this.maxListeners = maxListeners;
        // Upgraded(address indexed implementation) event signature
        this.upgradeEventSignature = (ethers as any).id("Upgraded(address)");
    }

    /**
     * Add event listener for a proxy contract
     * @param proxyAddress The proxy contract address to monitor
     */
    async addListener(proxyAddress: string): Promise<void> {
        if (this.listeners.has(proxyAddress)) {
            console.log(`⚠️  Listener for proxy ${proxyAddress} already exists`);
            return;
        }

        // Check listener count limit
        if (this.listeners.size >= this.maxListeners) {
            console.warn(`⚠️  Maximum listener limit (${this.maxListeners}) reached. Skipping listener for ${proxyAddress}`);
            return;
        }

        try {
            const filter = {
                address: proxyAddress,
                topics: [this.upgradeEventSignature]
            };

            const listener = (log: any) => {
                this.handleUpgradeEvent(log, proxyAddress);
            };

            this.provider.on(filter, listener);
            this.listeners.set(proxyAddress, { filter, listener });
            
            console.log(`🎧 Added upgrade event listener for proxy: ${proxyAddress}`);
        } catch (error) {
            console.error(`Failed to add listener for proxy ${proxyAddress}:`, error);
        }
    }

    /**
     * Remove event listener for a proxy contract
     * @param proxyAddress The proxy contract address to stop monitoring
     */
    async removeListener(proxyAddress: string): Promise<void> {
        const listenerData = this.listeners.get(proxyAddress);
        if (!listenerData) {
            console.log(`⚠️  No listener found for proxy ${proxyAddress}`);
            return;
        }

        try {
            this.provider.off(listenerData.filter, listenerData.listener);
            this.listeners.delete(proxyAddress);
            console.log(`🔇 Removed upgrade event listener for proxy: ${proxyAddress}`);
        } catch (error) {
            console.error(`Failed to remove listener for proxy ${proxyAddress}:`, error);
        }
    }

    /**
     * Handle upgrade event when detected
     * @param log The event log
     * @param proxyAddress The proxy contract address
     */
    private async handleUpgradeEvent(log: any, proxyAddress: string): Promise<void> {
        try {
            console.log(`🔥 Upgrade event detected for proxy: ${proxyAddress}`);
            console.log(`  - Transaction hash: ${log.transactionHash}`);
            console.log(`  - Block number: ${log.blockNumber}`);
            
            // Extract new implementation address from event topics (indexed parameter)
            // topics[1] is 32 bytes padded, we need to take the last 20 bytes (40 hex chars) for the address
            const addressFromTopic = log.topics[1].slice(-40); // Get last 40 characters
            const newImplementation = (ethers as any).getAddress('0x' + addressFromTopic);
            console.log(`  - New implementation: ${newImplementation}`);

            // Save upgrade event to database
            await this.saveUpgradeEvent(proxyAddress, newImplementation, log.transactionHash, log.blockNumber);

            // Telegram alert (non-blocking)
            try {
                if (isTelegramEnabled()) {
                    const message = buildUpgradeAlertMessage({
                        proxyAddress,
                        newImplementation,
                        blockNumber: log.blockNumber,
                        txHash: log.transactionHash,
                        detection: 'event',
                    });
                    await sendTelegramAlert(message);
                }
            } catch (alertErr) {
                console.warn(`Telegram alert error (event): ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
            }

            // Trigger security analysis for this specific pair if analyze mode is enabled
            if (analyzeModeEnabled) {
                try {
                    console.log(`[analyze] Triggering checks for upgraded pair proxy=${proxyAddress} logic=${newImplementation}`);
                    await analyzePairAddresses(proxyAddress.toLowerCase(), newImplementation.toLowerCase(), selectedPairCheckKeys);
                } catch (e: any) {
                    console.error(`[analyze] Pair analysis failed for ${proxyAddress} -> ${newImplementation}: ${e?.message || String(e)}`);
                }
            }

        } catch (error) {
            console.error(`Error handling upgrade event for ${proxyAddress}:`, error);
        }
    }

    /**
     * Save upgrade event to database
     */
    private async saveUpgradeEvent(proxyAddress: string, newImplementation: string, txHash: string, blockNumber: number): Promise<void> {
        if (!isDatabaseAvailable) {
            console.log(`Database not available, upgrade event logged but not saved: ${proxyAddress} -> ${newImplementation}`);
            return;
        }

        try {
            await saveOrUpdateProxyContract(proxyAddress, newImplementation, '', blockNumber, txHash);
            console.log(`✅ Upgrade event saved to database: ${proxyAddress} -> ${newImplementation}`);
        } catch (error) {
            console.error(`Failed to save upgrade event to database:`, error);
        }
    }

    /**
     * Get count of active listeners
     */
    getListenerCount(): number {
        return this.listeners.size;
    }

    /**
     * Get all monitored proxy addresses
     */
    getMonitoredProxies(): string[] {
        return Array.from(this.listeners.keys());
    }

    /**
     * Get listener status information
     */
    getListenerStatus(): { current: number; max: number; available: number } {
        return {
            current: this.listeners.size,
            max: this.maxListeners,
            available: this.maxListeners - this.listeners.size
        };
    }

    /**
     * Remove all listeners (cleanup)
     */
    async removeAllListeners(): Promise<void> {
        console.log(`🧹 Cleaning up ${this.listeners.size} proxy event listeners...`);
        for (const proxyAddress of this.listeners.keys()) {
            await this.removeListener(proxyAddress);
        }
    }
}

// Storage slot monitor for non-EIP1967 proxy contracts
class StorageSlotMonitor {
    private monitoredProxies: Map<string, string> = new Map(); // proxyAddress -> lastKnownLogicAddress
    private provider: any;
    private checkInterval: number; // milliseconds
    private intervalId: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;

    constructor(provider: any, checkInterval: number = 30000) { // Default 30 seconds
        this.provider = provider;
        this.checkInterval = checkInterval;
    }

    /**
     * Add a proxy contract to monitoring list
     * @param proxyAddress The proxy contract address to monitor
     * @param initialLogicAddress The initial logic contract address (can be empty)
     */
    async addProxy(proxyAddress: string, initialLogicAddress: string = ''): Promise<void> {
        if (this.monitoredProxies.has(proxyAddress)) {
            console.log(`⚠️  Proxy ${proxyAddress} is already being monitored`);
            return;
        }

        // Try to detect current implementation address from storage slots
        let currentLogicAddress = initialLogicAddress;
        if (!currentLogicAddress || currentLogicAddress === '0x0000000000000000000000000000000000000000') {
            console.log(`🔍 Detecting current implementation for ${proxyAddress}...`);
            const foundAddresses = await this.checkProxyStorageSlot(proxyAddress);
            if (foundAddresses.length > 0) {
                currentLogicAddress = foundAddresses[0]; // Use the first valid address found
                console.log(`✅ Auto-detected implementation: ${currentLogicAddress}`);
                // Persist immediately so DB reflects the discovered implementation even without a change event
                try {
                    await this.saveUpgradeEvent(proxyAddress, currentLogicAddress, 'initial_storage_detection');
                } catch (persistError) {
                    console.error(`Failed to persist initially detected implementation for ${proxyAddress}:`, persistError);
                }
            } else {
                currentLogicAddress = '0x0000000000000000000000000000000000000000';
                console.log(`⚠️  No implementation detected, will monitor for future implementations`);
            }
        }

        this.monitoredProxies.set(proxyAddress, currentLogicAddress.toLowerCase());
        console.log(`📊 Added proxy ${proxyAddress} to storage slot monitoring (current logic: ${currentLogicAddress})`);
    }

    /**
     * Remove a proxy contract from monitoring
     * @param proxyAddress The proxy contract address to stop monitoring
     */
    removeProxy(proxyAddress: string): void {
        if (this.monitoredProxies.has(proxyAddress)) {
            this.monitoredProxies.delete(proxyAddress);
            console.log(`🗑️  Removed proxy ${proxyAddress} from storage slot monitoring`);
        }
    }

    /**
     * Start the monitoring process
     */
    startMonitoring(): void {
        if (this.isRunning) {
            console.log(`⚠️  Storage slot monitor is already running`);
            return;
        }

        console.log(`🚀 Starting storage slot monitoring for ${this.monitoredProxies.size} proxies (interval: ${this.checkInterval}ms)`);
        this.isRunning = true;

        this.intervalId = setInterval(() => {
            this.checkAllProxies();
        }, this.checkInterval);
    }

    /**
     * Stop the monitoring process
     */
    stopMonitoring(): void {
        if (!this.isRunning) {
            return;
        }

        console.log(`🛑 Stopping storage slot monitoring...`);
        this.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Check storage slots for a single proxy - scan multiple slots and extract possible contract addresses
     */
    private async checkProxyStorageSlot(proxyAddress: string): Promise<string[]> {
        const foundAddresses: string[] = [];
        const foundSet: Set<string> = new Set();

        // Build dynamic custom slots from known keys
        const toBytes32 = (hex: string): string => {
            const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
            return '0x' + clean.padStart(64, '0');
        };
        const minusOne = (hex: string): string => {
            try {
                const n = BigInt(hex);
                if (n === 0n) return hex; // avoid underflow
                const dec = (n - 1n).toString(16).padStart(64, '0');
                return '0x' + dec;
            } catch {
                return hex;
            }
        };

        const dynamicKeyStrings = [
            // Common custom patterns; extendable without code changes
            'simple.proxy.impl',
            'proxy.implementation',
            'implementation'
        ];
        const dynamicSlots: string[] = [];
        for (const key of dynamicKeyStrings) {
            try {
                const h = (ethers as any).id(key); // keccak256(utf8(key))
                const h32 = toBytes32(h);
                dynamicSlots.push(h32);
                dynamicSlots.push(minusOne(h32));
            } catch {
                // ignore single key failure
            }
        }

        // Check a range of common slots (priority order)
        const slotsToCheck = [
            // Prefer EIP-1967 first
            '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', // keccak256("eip1967.proxy.implementation")
            '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103', // EIP-1967 admin (sometimes misused to store impl)

            // OpenZeppelin historical
            '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3', // keccak256("org.zeppelinos.proxy.implementation")

            // Dynamic custom slots (runtime keccak + minus-one variants)
            ...dynamicSlots,

            // Direct slots (fallbacks)
            '0x0000000000000000000000000000000000000000000000000000000000000000', // slot 0
            '0x0000000000000000000000000000000000000000000000000000000000000001', // slot 1
            '0x0000000000000000000000000000000000000000000000000000000000000002', // slot 2
            '0x0000000000000000000000000000000000000000000000000000000000000003', // slot 3

            // Hardcoded fallbacks kept for compatibility (may catch legacy/custom)
            '0x37722d2c9f3a89a6e4315c7c2e76f6b8c6b7a2b9f4d3c8e1a0b5f2e9c7d6a8b3e4',
            '0x421c7b3cd1b1c4a4bc48c2635d1b7b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b',
            '0x2c7e8a8c3b1c6b5d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
            '0x5c60da1b00000000000000000000000000000000000000000000000000000000'
        ];

        // Also check some keccak256 hashed slots
        const hashedSlots = [
            "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // keccak256("eip1967.proxy.implementation")
        ];

        // Check all predefined slots
        for (const slot of [...slotsToCheck, ...hashedSlots]) {
            try {
                const payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_getStorageAt",
                    "params": [
                        proxyAddress,
                        slot,
                        "latest"
                    ]
                };

                const response = await this.provider.send(payload.method, payload.params);
                if (response && response !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
                    // Analyze the 32-byte response for possible contract addresses
                    const addresses = this.extractAddressesFromStorage(response);
                    for (const address of addresses) {
                        const lower = address.toLowerCase();
                        if (this.isValidContractAddress(address) && !foundSet.has(lower)) {
                            // Strong validation: ensure the candidate actually has deployed bytecode
                            const hasCode = await this.hasContractCode(address);
                            if (!hasCode) {
                                console.log(`⛔  Skipping storage candidate without code (likely numeric noise) at slot ${slot} for ${proxyAddress}: ${address}`);
                                continue;
                            }
                            console.log(`✅ Found potential implementation at slot ${slot} for ${proxyAddress}: ${address}`);
                            foundAddresses.push(address);
                            foundSet.add(lower);
                        }
                    }
                }
            } catch (error) {
                console.warn(`Error checking slot ${slot} for ${proxyAddress}:`, error instanceof Error ? error.message : String(error));
                // Continue to next slot
            }
        }

        if (foundAddresses.length > 0) {
            console.log(`🎯 Found ${foundAddresses.length} potential implementation addresses for ${proxyAddress}`);
        } else {
            console.log(`❌ No implementation found in checked slots for ${proxyAddress}`);
        }

        return foundAddresses;
    }

    /**
     * Extract possible contract addresses from 32-byte storage data
     */
    private extractAddressesFromStorage(storageData: string): string[] {
        const addresses: string[] = [];

        if (!storageData.startsWith('0x')) {
            storageData = '0x' + storageData;
        }

        const data = storageData.slice(2);

        // Canonical extraction: last 20 bytes of the 32-byte slot
        if (data.length >= 64) {
            const last20 = data.substring(64 - 40);
            const address = '0x' + last20;
            if (this.isValidContractAddress(address)) {
                addresses.push(address);
            }
        }

        return addresses;
    }

    /**
     * Validate if a string is a valid contract address
     */
    private isValidContractAddress(address: string): boolean {
        // Check basic format
        if (!address.match(/^0x[0-9a-fA-F]{40}$/) || address.length !== 42) {
            return false;
        }

        // Check if it's not a zero address
        if (address === '0x0000000000000000000000000000000000000000') {
            return false;
        }

        // Check if it's not a common zero-filled address
        if (address.match(/^0x0{39}[1-9a-fA-F]$/)) {
            return false;
        }

        return true;
    }

    /**
     * Check if an address has deployed bytecode (strong validation to filter numeric noise)
     */
    private async hasContractCode(address: string): Promise<boolean> {
        try {
            const code = await this.provider.send('eth_getCode', [address, 'latest']);
            return !!code && code !== '0x';
        } catch (e) {
            console.warn(`eth_getCode failed for ${address}:`, e instanceof Error ? e.message : String(e));
            return false;
        }
    }

    /**
     * Check all monitored proxies for changes
     */
    private async checkAllProxies(): Promise<void> {
        if (this.monitoredProxies.size === 0) {
            return;
        }

        console.log(`🔍 Checking ${this.monitoredProxies.size} non-EIP1967 proxies for upgrades...`);

        for (const [proxyAddress, lastKnownLogic] of this.monitoredProxies.entries()) {
            try {
                const currentLogics = await this.checkProxyStorageSlot(proxyAddress);

                // If we found multiple addresses, log them all
                if (currentLogics.length > 1) {
                    console.log(`🔍 Found ${currentLogics.length} potential implementations for ${proxyAddress}:`);
                    currentLogics.forEach((logic, index) => {
                        console.log(`  ${index + 1}. ${logic}`);
                    });
                }

                // Check if any of the found addresses differ from the last known
                let upgradeDetected = false;
                let newLogicAddress = lastKnownLogic;

                for (const currentLogic of currentLogics) {
                    if (currentLogic.toLowerCase() !== lastKnownLogic.toLowerCase()) {
                        // Logic contract changed! This is an upgrade
                        console.log(`🔥 Storage slot upgrade detected for proxy: ${proxyAddress}`);
                        console.log(`  - Previous logic: ${lastKnownLogic}`);
                        console.log(`  - New logic: ${currentLogic}`);

                        upgradeDetected = true;
                        newLogicAddress = currentLogic;
                        break; // Use the first different address we find
                    }
                }

                if (upgradeDetected) {
                    // Update our record
                    this.monitoredProxies.set(proxyAddress, newLogicAddress.toLowerCase());

                    // Save upgrade event to database
                    await this.saveUpgradeEvent(proxyAddress, newLogicAddress, 'storage_slot_change');
                } else if (currentLogics.length === 0) {
                    console.warn(`⚠️  Could not read logic contract from storage slots for ${proxyAddress}`);
                }
            } catch (error) {
                console.error(`Error checking proxy ${proxyAddress}:`, error);
            }
        }
    }

    /**
     * Save upgrade event to database
     */
    private async saveUpgradeEvent(proxyAddress: string, newImplementation: string, detectionMethod: string): Promise<void> {
        if (!isDatabaseAvailable) {
            console.log(`Database not available, upgrade event logged but not saved: ${proxyAddress} -> ${newImplementation}`);
            return;
        }

        try {
            // For storage slot monitoring, we don't have transaction hash, so we pass empty string
            await saveOrUpdateProxyContract(proxyAddress, newImplementation, '', 0, '');
            console.log(`✅ Storage slot upgrade saved to database: ${proxyAddress} -> ${newImplementation} (${detectionMethod})`);

            // Telegram alert (non-blocking)
            try {
                if (isTelegramEnabled()) {
                    const message = buildUpgradeAlertMessage({
                        proxyAddress,
                        newImplementation,
                        detection: 'storage',
                    });
                    await sendTelegramAlert(message);
                }
            } catch (alertErr) {
                console.warn(`Telegram alert error (storage): ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
            }

            // Trigger security analysis asynchronously if analyze mode is enabled
            if (analyzeModeEnabled) {
                try {
                    console.log(`[analyze] Triggering checks (storage) for upgraded pair proxy=${proxyAddress} logic=${newImplementation}`);
                    // Fire and forget; do not block the monitoring loop
                    analyzePairAddresses(proxyAddress.toLowerCase(), newImplementation.toLowerCase(), selectedPairCheckKeys)
                        .catch((e) => console.error(`[analyze] Background analysis failed for ${proxyAddress}:`, e instanceof Error ? e.message : String(e)));
                } catch (e) {
                    console.error(`[analyze] Failed to schedule analysis for ${proxyAddress}:`, e instanceof Error ? e.message : String(e));
                }
            }
        } catch (error) {
            console.error(`Failed to save storage slot upgrade to database:`, error);
        }
    }

    /**
     * Get monitoring status
     */
    getStatus(): { monitoredCount: number; isRunning: boolean; checkInterval: number } {
        return {
            monitoredCount: this.monitoredProxies.size,
            isRunning: this.isRunning,
            checkInterval: this.checkInterval
        };
    }

    /**
     * Get all monitored proxies
     */
    getMonitoredProxies(): string[] {
        return Array.from(this.monitoredProxies.keys());
    }
}

// Bytecode analysis functions
function skipPush(pushOp: number, counter: number): number {
    // PUSH1 in dec -> 96, PUSH32 in dec -> 127
    // To get amount of bytes to push (amount to skip), subtract 95 from opcode
    return pushOp - 95;
}

function compareOpcodes(bytecode: string, targetOpcode: number): boolean {
    // Remove 0x prefix if present
    const cleanBytecode = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;

    // Convert hex string to byte array
    const bytecodeBytes = [];
    for (let i = 0; i < cleanBytecode.length; i += 2) {
        bytecodeBytes.push(parseInt(cleanBytecode.substr(i, 2), 16));
    }

    let i = 0;
    while (i < bytecodeBytes.length) {
        const op = bytecodeBytes[i];

        // Check if it's a PUSH opcode (PUSH1 = 0x60, PUSH32 = 0x7F)
        if (op >= 0x60 && op <= 0x7F) {
            // Skip PUSH opcode and its argument
            const skipBytes = skipPush(op, i);
            i += skipBytes + 1; // +1 for the PUSH opcode itself
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
        // Use eth_getCode to get contract bytecode
        const payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getCode",
            "params": [address, "latest"]
        };

        const response = await provider.send(payload.method, payload.params);

        if (response && response !== "0x") {
            // Non-zero bytecode means it's a contract address
            console.log(`Address ${address} has bytecode, checking for opcode 0x${opcode.toString(16)}...`);
            return compareOpcodes(response, opcode);
        } else {
            console.log(`Address ${address} is not a contract or has no bytecode`);
            return false;
        }
    } catch (error) {
        console.error(`Error checking bytecode for ${address}:`, error);
        return false;
    }
}

// Database functions
async function createTablesIfNotExist() {
    if (!pool) {
        console.log("Database pool not initialized, skipping table creation");
        return;
    }

    const client = await pool.connect();
    try {
        // Create proxy_contracts table if it doesn't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_contracts (
                proxy_address VARCHAR(42) PRIMARY KEY,
                logic_contract VARCHAR(42),
                admin_contract VARCHAR(42),
                detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                block_number BIGINT,
                contract_type VARCHAR(50) DEFAULT 'unknown'
            )
        `);

        // Create index for faster queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_proxy_contracts_logic ON proxy_contracts(logic_contract)
        `);

        console.log("Database tables created successfully");
    } catch (error) {
        console.error("Error creating database tables:", error);
        throw error;
    } finally {
        client.release();
    }
}

async function saveOrUpdateProxyContract(proxyAddress: string, logicContract: string, adminContract: string = '', blockNumber: number, upgradeTxHash: string = '') {
    if (!isDatabaseAvailable || !pool) {
        console.log(`Database not available, skipping save for proxy contract: ${proxyAddress}`);
        return;
    }

    const client = await pool.connect();
    try {
        // Check if proxy contract with same logic contract already exists
        const existingQuery = 'SELECT proxy_address FROM proxy_contracts WHERE proxy_address = $1 AND logic_contract = $2';
        const existingResult = await client.query(existingQuery, [proxyAddress.toLowerCase(), logicContract.toLowerCase()]);

        if (existingResult.rows.length > 0) {
            // Proxy contract with same logic contract already exists, skip insertion
            console.log(`⏭️  Skipped: proxy contract ${proxyAddress} with logic ${logicContract} already exists`);
            return;
        } else {
            // Insert new proxy contract record (even if proxy_address exists with different logic)
            let insertQuery = ``;
            let queryParams: any[] = [];

            if (upgradeTxHash) {
                // Include upgrade_tx_hash if provided (for upgrade events)
                insertQuery = `
                    INSERT INTO proxy_contracts (proxy_address, logic_contract, admin_contract, block_number, upgrade_tx_hash)
                    VALUES ($1, $2, $3, $4, $5)
                `;
                queryParams = [
                    proxyAddress.toLowerCase(),
                    logicContract.toLowerCase(),
                    adminContract ? adminContract.toLowerCase() : null,
                    blockNumber,
                    upgradeTxHash
                ];
            } else {
                // Original insert without upgrade_tx_hash (for discovery)
                insertQuery = `
                    INSERT INTO proxy_contracts (proxy_address, logic_contract, admin_contract, block_number)
                    VALUES ($1, $2, $3, $4)
                `;
                queryParams = [
                    proxyAddress.toLowerCase(),
                    logicContract.toLowerCase(),
                    adminContract ? adminContract.toLowerCase() : null,
                    blockNumber
                ];
            }

            await client.query(insertQuery, queryParams);
            
            if (upgradeTxHash) {
                console.log(`🆕 Inserted upgrade event record: ${proxyAddress} -> ${logicContract} (tx: ${upgradeTxHash})`);
            } else {
                console.log(`🆕 Inserted new proxy contract record: ${proxyAddress} -> ${logicContract}`);
            }
        }
    } catch (error) {
        console.error(`Error saving proxy contract ${proxyAddress}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

// Scan block for potential proxy contracts using bytecode analysis (with retry mechanism)
async function find_potential_proxies_with_bytecode_analysis(blockNumber: number, maxRetries: number = 5, retryDelay: number = 2000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Scanning block ${blockNumber} with bytecode analysis to find proxy contracts... (attempt ${attempt + 1}/${maxRetries + 1})`);

            // Get block with transactions
            const block = await provider.getBlock(blockNumber, true);
            if (!block) {
                console.log(`Block ${blockNumber} not found`);
                return;
            }

            // Collect all addresses from transactions
            const addressesToCheck = new Set<string>();

            for (const tx of block.prefetchedTransactions) {
                // Add 'from' address
                if (tx.from) {
                    addressesToCheck.add(tx.from);
                }

                // Add 'to' address (if not contract creation)
                if (tx.to) {
                    addressesToCheck.add(tx.to);
                }

                // For contract creation transactions, get the contract address from receipt
                if (tx.to === null) {
                    try {
                        const receipt = await provider.getTransactionReceipt(tx.hash);
                        if (receipt && receipt.contractAddress) {
                            addressesToCheck.add(receipt.contractAddress);
                        }
                    } catch (error) {
                        console.warn(`Failed to get receipt for contract creation tx ${tx.hash}:`, error);
                    }
                }
            }

            console.log(`Block ${blockNumber} found ${addressesToCheck.size} unique addresses to check`);

            // Check bytecode for each address concurrently but with limit
            const DELEGATECALL_OPCODE = 0xf4; // DELEGATECALL opcode in hex
            const checkPromises = Array.from(addressesToCheck).map(address =>
                checkBytecodeForOpcode(address, DELEGATECALL_OPCODE)
            );

            // Process in batches to avoid overwhelming the RPC
            const batchSize = 10;
            let foundProxies = 0;

            for (let i = 0; i < checkPromises.length; i += batchSize) {
                const batch = checkPromises.slice(i, i + batchSize);
                const results = await Promise.all(batch);

                for (let j = 0; j < results.length; j++) {
                    if (results[j]) {
                        const address = Array.from(addressesToCheck)[i + j];
                        console.log(`Found proxy contract address: ${address}`);

                        // Add to queue for type checking and database saving
                        proxyAddressQueue.push({ address, blockNumber });
                        foundProxies++;
                    }
                }
            }

            if (foundProxies > 0) {
                console.log(`Block ${blockNumber} found ${foundProxies} proxy contracts, added to queue, current queue length: ${proxyAddressQueue.length}`);
            } else {
                console.log(`Block ${blockNumber} no proxy contracts found`);
            }

            return; // Successfully completed, exit function

        } catch (error: any) {
            // Check if it's a "block in the future" error
            const isBlockInFuture = error?.error?.message?.includes('block in the future') ||
                                  error?.message?.includes('block in the future');

            if (isBlockInFuture && attempt < maxRetries) {
                console.log(`Block ${blockNumber} is in the future, waiting ${retryDelay}ms before retry... (${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }

            // If not a future block error, or max retries reached, throw error
            console.error(`Block ${blockNumber} bytecode analysis failed (attempt ${attempt + 1}/${maxRetries + 1}):`, error);
            throw error;
        }
    }
}

// Consume proxy contract addresses from queue, query storage to determine proxy type
async function consumeProxyAddressQueue() {
    while (true) {
        if (proxyAddressQueue.length > 0) {
            // Batch process addresses in queue
            const batchSize = Math.min(CONCURRENCY_CONFIG.BATCH_SIZE, proxyAddressQueue.length);
            const batchItems = proxyAddressQueue.splice(0, batchSize); // Take out a batch of items from queue head

            if (batchItems.length > 0) {
                // Extract addresses and block numbers
                const batchAddresses = batchItems.map(item => item.address);
                const blockNumber = batchItems[0].blockNumber; // Use the first item's block number

                // Process this batch of addresses concurrently
                await checkProxyTypesBatch(batchAddresses, blockNumber);
            }
        } else {
            // Wait when queue is empty
            await new Promise(resolve => setTimeout(resolve, CONCURRENCY_CONFIG.QUEUE_PROCESS_INTERVAL));
        }
    }
}

// Check proxy contract types in batch
async function checkProxyTypesBatch(contractAddresses: string[], blockNumber: number = 0) {
    if (contractAddresses.length === 0) return;

    try {
        console.log(`Checking proxy contract types for ${contractAddresses.length} contracts`);

        // Build batch storage query requests
        const storageRequests = contractAddresses.flatMap((address, index) => [
            {
                "jsonrpc": "2.0",
                "id": index * 2 + 1,
                "method": "eth_getStorageAt",
                "params": [
                    address,
                    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967 logic contract storage slot
                    "latest"
                ]
            },
            {
                "jsonrpc": "2.0",
                "id": index * 2 + 2,
                "method": "eth_getStorageAt",
                "params": [
                    address,
                    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // EIP-1967 admin storage slot
                    "latest"
                ]
            }
        ]);

        // Send batch query requests concurrently, but limit concurrency
        const batchSize = CONCURRENCY_CONFIG.MAX_CONCURRENT_STORAGE_QUERIES;
        const results = [];

        for (let i = 0; i < storageRequests.length; i += batchSize) {
            const batch = storageRequests.slice(i, i + batchSize);
            const batchPromises = batch.map(req => provider.send(req.method, req.params));
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }

        // Process results
        for (let i = 0; i < contractAddresses.length; i++) {
            const contractAddress = contractAddresses[i];
            const logicResponse = results[i * 2];
            const adminResponse = results[i * 2 + 1];

            await processProxyTypeResult(contractAddress, logicResponse, adminResponse, blockNumber);
        }

    } catch (error) {
        console.error(`Error occurred when checking proxy contracts batch:`, error);
        // If batch query fails, fall back to individual queries
        console.log("Falling back to individual queries...");
        for (const address of contractAddresses) {
            await checkProxyType(address, blockNumber);
        }
    }
}

// Check proxy contract type (keep original interface for fallback)
async function checkProxyType(contractAddress: string, blockNumber: number = 0, attempt: number = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 10_000;
    try {
        console.log(`Checking proxy contract type: ${contractAddress}`);

        // Query logic contract and admin address storage slots in parallel
        const logicPayload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getStorageAt",
            "params": [
                contractAddress,
                "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967 logic contract storage slot
                "latest"
            ]
        };

        const adminPayload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "eth_getStorageAt",
            "params": [
                contractAddress,
                "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // EIP-1967 admin storage slot
                "latest"
            ]
        };

        const [logicResponse, adminResponse] = await Promise.all([
            provider.send(logicPayload.method, logicPayload.params),
            provider.send(adminPayload.method, adminPayload.params)
        ]);

        console.log("eth_getStorageAt response logic contract", logicResponse);
        console.log("eth_getStorageAt response admin", adminResponse);

        await processProxyTypeResult(contractAddress, logicResponse, adminResponse, blockNumber);

    } catch (error: any) {
        const msg = error?.message || String(error || '');
        const isRateLimit =
            msg.includes('Too many requests') ||
            msg.includes('rate limit') ||
            (error?.code === 'BAD_DATA' && /Too many requests/i.test(JSON.stringify(error?.value || '')));

        if (isRateLimit && attempt < MAX_RETRIES) {
            console.warn(`[rate-limit] eth_getStorageAt hit rate limit for ${contractAddress}, attempt=${attempt + 1}/${MAX_RETRIES}. Waiting ${RETRY_DELAY_MS}ms before retry...`);
            await sleep(RETRY_DELAY_MS);
            return checkProxyType(contractAddress, blockNumber, attempt + 1);
        }

        console.error(`Error occurred when checking proxy contract ${contractAddress} type:`, error);
    }
}

// Process proxy contract type check results (extract common logic)
async function processProxyTypeResult(contractAddress: string, logicResponse: string, adminResponse: string, blockNumber: number = 0) {
    // Helper function to clean address format
    const cleanAddress = (value: string) => {
        const clean = value.startsWith('0x') ? value : '0x' + value;
        return clean.replace(/^0x0+/, '0x');
    };

    // Helper function to check if address format is valid
    const isValidAddress = (addr: string) => {
        return addr.match(/^0x[0-9a-fA-F]{40}$/) && addr.length === 42;
    };

    // Helper function to determine proxy type based on storage slot values
    const getProxyType = (logicResp: string, adminResp: string, logicAddr: string, adminAddr: string): 'eip1967' | 'non-eip1967' | 'unknown' => {
        // Check if both slots are properly set with valid addresses
        if (isValidAddress(logicAddr) && isValidAddress(adminAddr)) {
            return 'eip1967'; // Both logic and admin slots have valid addresses
        } else if (isValidAddress(logicAddr) && !isValidAddress(adminAddr)) {
            return 'non-eip1967'; // Only logic slot has valid address, admin slot empty or invalid
        }
        return 'unknown';
    };

    if (logicResponse && adminResponse) {
        const logicStorageValue = cleanAddress(logicResponse);
        const adminStorageValue = cleanAddress(adminResponse);

        console.log(`Contract ${contractAddress} logic contract storage value: ${logicStorageValue}`);
        console.log(`Contract ${contractAddress} admin storage value: ${adminStorageValue}`);

        // Check logic contract storage slot
        const isLogicZero = logicResponse === "0x0000000000000000000000000000000000000000000000000000000000000000";
        const isAdminZero = adminResponse === "0x0000000000000000000000000000000000000000000000000000000000000000";

        if (isLogicZero && isAdminZero) {
            console.log(` Found non-standard proxy contract: ${contractAddress}`);
            // Even if storage slots are empty, save it as a proxy contract since it was detected by bytecode analysis
            // We'll monitor it using storage slot monitoring to detect any future implementations
            try {
                // Do NOT insert a blank logic record; only start monitoring without DB write

                // Add to storage slot monitoring to watch for future implementations
                if (storageSlotMonitor) {
                    try {
                        await storageSlotMonitor.addProxy(contractAddress, '0x0000000000000000000000000000000000000000'); // Empty initial logic
                        console.log(`📊 Added storage monitoring for non-standard proxy: ${contractAddress} (waiting for implementation)`);
                    } catch (monitorError) {
                        console.error(`Failed to add storage monitoring for proxy ${contractAddress}:`, monitorError);
                    }
                } else {
                    console.warn(`StorageSlotMonitor not initialized, skipping storage monitoring for ${contractAddress}`);
                }
            } catch (dbError) {
                console.error(`Failed to save non-standard proxy contract ${contractAddress} to database:`, dbError);
            }
        } else if (isValidAddress(logicStorageValue) && !isLogicZero) {
            const proxyType = getProxyType(logicResponse, adminResponse, logicStorageValue, adminStorageValue);

            if (proxyType === 'eip1967') {
                console.log(` 🔍Found EIP1967 proxy contract: ${contractAddress}`);
                console.log(`    Logic contract: ${logicStorageValue}`);
                if (!isAdminZero && isValidAddress(adminStorageValue)) {
                    console.log(` Admin address: ${adminStorageValue}`);
                } else {
                    console.log(` Admin: Not set or invalid`);
                }

                // Save to database with logic and admin contract information
                try {
                    await saveOrUpdateProxyContract(
                        contractAddress,
                        logicStorageValue,
                        isValidAddress(adminStorageValue) && !isAdminZero ? adminStorageValue : '',
                        blockNumber
                    );

                    // Telegram alert on discovery for standard proxy
                    try {
                        if (isTelegramEnabled()) {
                            const message = buildUpgradeAlertMessage({
                                proxyAddress: contractAddress,
                                newImplementation: logicStorageValue,
                                blockNumber,
                                detection: 'discovery',
                            });
                            await sendTelegramAlert(message);
                        }
                    } catch (alertErr) {
                        console.warn(`Telegram alert error (discovery): ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
                    }

                    // Trigger security analysis for discovered proxy if analyze mode is enabled
                    if (analyzeModeEnabled) {
                        try {
                            console.log(`[analyze] Triggering checks (discovery) for proxy pair proxy=${contractAddress} logic=${logicStorageValue}`);
                            // Fire and forget; do not block the discovery process
                            analyzePairAddresses(contractAddress.toLowerCase(), logicStorageValue.toLowerCase(), selectedPairCheckKeys)
                                .catch((e) => console.error(`[analyze] Background analysis failed for discovered proxy ${contractAddress}:`, e instanceof Error ? e.message : String(e)));
                        } catch (e) {
                            console.error(`[analyze] Failed to schedule analysis for discovered proxy ${contractAddress}:`, e instanceof Error ? e.message : String(e));
                        }
                    }

                    // Ensure we do NOT monitor slots for standard proxies
                    if (storageSlotMonitor) {
                        try {
                            storageSlotMonitor.removeProxy(contractAddress);
                        } catch (monitorError) {
                            console.error(`Failed to remove storage monitoring for standard proxy ${contractAddress}:`, monitorError);
                        }
                    }

                    // Add event listener for EIP1967/UUPS proxy contract
                    if (proxyEventListener) {
                        try {
                            await proxyEventListener.addListener(contractAddress);
                            console.log(`🎧 Added upgrade event monitoring for EIP1967 proxy: ${contractAddress}`);
                        } catch (listenerError) {
                            console.error(`Failed to add event listener for proxy ${contractAddress}:`, listenerError);
                        }
                    } else {
                        console.warn(`ProxyEventListener not initialized, skipping event monitoring for ${contractAddress}`);
                    }
                } catch (dbError) {
                    console.error(`Failed to save proxy contract ${contractAddress} to database:`, dbError);
                }

            } else if (proxyType === 'non-eip1967') {
                console.log(` 🔍Found standard proxy (EIP1967 logic without admin/UUPS): ${contractAddress}`);
                console.log(`    Logic contract: ${logicStorageValue}`);

                // Save to database
                try {
                    await saveOrUpdateProxyContract(
                        contractAddress,
                        logicStorageValue,
                        '', // UUPS/standard without admin slot
                        blockNumber
                    );

                    // Telegram alert on discovery for non-EIP1967 proxy
                    try {
                        if (isTelegramEnabled()) {
                            const message = buildUpgradeAlertMessage({
                                proxyAddress: contractAddress,
                                newImplementation: logicStorageValue,
                                blockNumber,
                                detection: 'discovery',
                            });
                            await sendTelegramAlert(message);
                        }
                    } catch (alertErr) {
                        console.warn(`Telegram alert error (discovery): ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
                    }

                    // Trigger security analysis for discovered non-EIP1967 proxy if analyze mode is enabled
                    if (analyzeModeEnabled) {
                        try {
                            console.log(`[analyze] Triggering checks (discovery) for non-EIP1967 proxy pair proxy=${contractAddress} logic=${logicStorageValue}`);
                            // Fire and forget; do not block the discovery process
                            analyzePairAddresses(contractAddress.toLowerCase(), logicStorageValue.toLowerCase(), selectedPairCheckKeys)
                                .catch((e) => console.error(`[analyze] Background analysis failed for discovered non-EIP1967 proxy ${contractAddress}:`, e instanceof Error ? e.message : String(e)));
                        } catch (e) {
                            console.error(`[analyze] Failed to schedule analysis for discovered non-EIP1967 proxy ${contractAddress}:`, e instanceof Error ? e.message : String(e));
                        }
                    }

                    // Ensure slot monitoring is NOT used for standard proxies; use events instead
                    if (storageSlotMonitor) {
                        try {
                            storageSlotMonitor.removeProxy(contractAddress);
                        } catch (monitorError) {
                            console.error(`Failed to remove storage monitoring for standard proxy ${contractAddress}:`, monitorError);
                        }
                    }

                    if (proxyEventListener) {
                        try {
                            await proxyEventListener.addListener(contractAddress);
                            console.log(`🎧 Added upgrade event monitoring for standard proxy (UUPS): ${contractAddress}`);
                        } catch (listenerError) {
                            console.error(`Failed to add event listener for proxy ${contractAddress}:`, listenerError);
                        }
                    } else {
                        console.warn(`ProxyEventListener not initialized, skipping event monitoring for ${contractAddress}`);
                    }
                } catch (dbError) {
                    console.error(`Failed to save proxy contract ${contractAddress} to database:`, dbError);
                }

            } else {
                console.log(` Found unknown proxy contract type: ${contractAddress}`);
                console.log(`   Logic contract storage value: ${logicStorageValue}`);
                console.log(`   Admin storage value: ${adminStorageValue}`);
            }
        } else {
            console.log(` Found proxy contract but storage value format abnormal: ${contractAddress}`);
            console.log(`   Logic contract storage value: ${logicStorageValue}`);
            // console.log(`   Admin storage value: ${adminStorageValue}`);
        }
    } else {
        console.log(`Contract ${contractAddress} query failed or no result`);
    }
}

// Concurrency control variables
let activeBlockScans = 0;
const pendingBlocks: number[] = [];

// Process block scanning concurrently
async function processBlockWithConcurrency(blockNumber: number) {
    if (activeBlockScans >= CONCURRENCY_CONFIG.MAX_CONCURRENT_BLOCKS) {
        // If concurrency limit is reached, add to waiting queue
        pendingBlocks.push(blockNumber);
        console.log(`Block ${blockNumber} queued for processing (active: ${activeBlockScans}, queued: ${pendingBlocks.length})`);
        return;
    }

    activeBlockScans++;
    try {
        await processBlock(blockNumber);
    } finally {
        activeBlockScans--;

        // Process next block in waiting queue
        if (pendingBlocks.length > 0) {
            const nextBlock = pendingBlocks.shift();
            if (nextBlock !== undefined) {
                setImmediate(() => processBlockWithConcurrency(nextBlock));
            }
        }
    }
}

// Process single block
async function processBlock(blockNumber: number) {
    console.log(`Processing block: ${blockNumber}`);
    const block = await provider.getBlock(blockNumber, true); // true means get complete transaction objects

    for (const tx of block.prefetchedTransactions) {
        // Check if to address is null, which is the sign of contract creation
        if (tx.to === null) {
            console.log("---------------------------------");
            console.log(`Contract creation transaction found!`);
            console.log(`  - Block number: ${blockNumber}`);
            console.log(`  - Transaction hash: ${tx.hash}`);
            console.log(`  - Creator address: ${tx.from}`);

            // Get new contract address through transaction receipt
            const receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt && receipt.contractAddress) {
                console.log(`  - New contract address: ${receipt.contractAddress}`);
            }
            console.log("---------------------------------");
        }
    }

    // Call bytecode analysis function to scan current block
    try {
        await find_potential_proxies_with_bytecode_analysis(blockNumber);
    } catch (error) {
        console.error(`Block ${blockNumber} bytecode analysis failed, skipping further processing:`, error);
        return; // Exit current callback function
    }
}

async function main() {
    try {
        // Parse mode flags
        const args: string[] = process.argv.slice(2).map((s: string) => s.trim()).filter(Boolean);
        const kv: Record<string, string> = Object.fromEntries(
            args.filter(a => a.includes('=')).map(a => {
                const [rawK, ...rest] = a.split('=');
                const k = rawK.replace(/^-+/, ''); // strip leading dashes, e.g., --mode -> mode
                return [k, rest.join('=')];
            })
        );
        // Handle help: list checks and exit
        const listChecksRequested = args.includes('--list-checks') || args.includes('-l') || kv['list-checks'] === '1';
        if (listChecksRequested) {
            // Keep output formatting consistent with request
            const lines: string[] = [];
            lines.push('Available Checks:');
            lines.push('');
            lines.push('- storage-collision:      Detects proxy/implementation storage slot collisions.');
            lines.push('- uninitialized-impl:     Checks for uninitialized implementation contracts.');
            lines.push('- admin-privilege:        Analyzes admin access control vulnerabilities.');
            lines.push('- mixing-patterns:        Detects EIP-1967 beacon-style initializer mixing patterns.');
            lines.push('- library-misuse:         Detects library misuse patterns.');
            console.log(lines.join('\n'));
            process.exit(0);
        }
        const modeArg = kv['mode'] || (args.includes('--analyze') ? 'listen-analyze' : undefined) || process.env.MODE;
        const analyzeEnabled = (process.env.ANALYZE === '1') || (modeArg === 'analyze') || (modeArg === 'listen-analyze');
        const checksArgRaw = kv['checks'] || process.env.CHECKS || kv['detectors'] || process.env.DETECTORS || '';
        const selectedCheckKeys = checksArgRaw
            ? checksArgRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
        // set globals for event-triggered analysis
        analyzeModeEnabled = !!analyzeEnabled;
        selectedPairCheckKeys = selectedCheckKeys;

        console.log("Initializing database...");
        console.log("Database config:", {
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password ? "***" : undefined
        });
        // Try to initialize database
        try {
            pool = new Pool(DB_CONFIG);
            await createTablesIfNotExist();
            isDatabaseAvailable = true;
            console.log("Database initialized successfully");
        } catch (dbError) {
            const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
            console.warn("Database not available, continuing without database functionality:", errorMessage);
            console.log("Proxy contracts will be detected but not saved to database");
            isDatabaseAvailable = false;
        }

        // Initialize proxy event listener (can be disabled for RPC endpoints that do not support eth_newFilter)
        const eventListenerDisabled = process.env.DISABLE_EVENT_LISTENER === '1';
        if (eventListenerDisabled) {
            console.log("[events] Proxy event listener disabled by DISABLE_EVENT_LISTENER=1; upgrade events will not be tracked.");
            proxyEventListener = null;
        } else {
            console.log("Initializing proxy event listener...");
            proxyEventListener = new ProxyEventListener(provider, 50); // Limit to 50 concurrent listeners
            console.log("Proxy event listener initialized successfully");
            console.log(`Event listener capacity: ${proxyEventListener.getListenerStatus().max} listeners`);
        }

        // Initialize storage slot monitor for non-EIP1967 proxies
        console.log("Initializing storage slot monitor...");
        storageSlotMonitor = new StorageSlotMonitor(provider, 30000); // Check every 30 seconds
        console.log("Storage slot monitor initialized successfully");
        console.log(`Storage slot monitoring interval: ${storageSlotMonitor.getStatus().checkInterval}ms`);

        // Start storage slot monitoring
        storageSlotMonitor.startMonitoring();

        // If analyze mode is enabled, do not run startup analysis; runtime events will trigger analysis
        if (analyzeEnabled) {
            console.log("[analyze] listen-and-analyze mode enabled.");
        } else {
            console.log("[analyze] listen-only mode (no startup analysis). Enable with --mode=listen-analyze or ANALYZE=1");
        }

        console.log("Starting to listen for new blocks...");
        console.log(`Concurrency config: max concurrent blocks = ${CONCURRENCY_CONFIG.MAX_CONCURRENT_BLOCKS}, batch size = ${CONCURRENCY_CONFIG.BATCH_SIZE}`);
        if (isDatabaseAvailable) {
            console.log("Database: ENABLED");
        } else {
            console.log("Database: DISABLED (no PostgreSQL connection)");
        }

        // Start queue consumer (running in background)
        consumeProxyAddressQueue().catch(error => {
            console.error("Queue consumer error:", error);
        });

        // 允许通过环境变量在某些场景（例如大批量 /monitor 回放）关闭实时区块扫描，以避免 RPC 频率过高
        const liveScanDisabled = process.env.DISABLE_LIVE_SCAN === '1';
        if (liveScanDisabled) {
            console.log("[scan] Live block scanning disabled by DISABLE_LIVE_SCAN=1; HTTP API and /monitor remain available.");
        } else {
            provider.on("block", async (blockNumber: number) => {
                console.log(`New block discovered: ${blockNumber}`);

                try {
                    // Use concurrency controller to process block
                    await processBlockWithConcurrency(blockNumber);
                } catch (error) {
                    console.error(`Error while processing block ${blockNumber}:`, error);
                }
            });
        }
    } catch (error) {
        console.error("Failed to start application:", error);
        process.exit(1);
    }
}

// Graceful shutdown
async function cleanup() {
    console.log("Shutting down gracefully...");
    try {
        // Clean up proxy event listeners
        if (proxyEventListener) {
            await proxyEventListener.removeAllListeners();
            console.log("Proxy event listeners cleaned up");
        }

        // Stop storage slot monitoring
        if (storageSlotMonitor) {
            storageSlotMonitor.stopMonitoring();
            console.log("Storage slot monitoring stopped");
        }

        if (isDatabaseAvailable && pool) {
            await pool.end();
            console.log("Database connection closed");
        }
    } catch (error) {
        console.error("Error during cleanup:", error);
    }
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch(error => {
    console.error("Error occurred:", error);
    cleanup();
});

// ----------------------
// Public API (for HTTP server)
// ----------------------

export function apiGetStatus() {
    const listenerStatus = proxyEventListener ? proxyEventListener.getListenerStatus() : { current: 0, max: 0, available: 0 };
    const monitorStatus = storageSlotMonitor ? storageSlotMonitor.getStatus() : { monitoredCount: 0, isRunning: false, checkInterval: 0 };
    return {
        db: { available: isDatabaseAvailable },
        listener: listenerStatus,
        storageMonitor: monitorStatus,
        queue: { length: proxyAddressQueue.length },
        concurrency: { activeBlockScans, pendingBlocks: pendingBlocks.length },
        rpc: RPC_URL
    };
}

export function apiGetMonitored() {
    return {
        eventListener: proxyEventListener ? proxyEventListener.getMonitoredProxies() : [],
        storageMonitor: storageSlotMonitor ? storageSlotMonitor.getMonitoredProxies() : []
    };
}

export async function apiListProxies(limit: number = 50, offset: number = 0) {
    if (!isDatabaseAvailable || !pool) {
        return { error: 'database_unavailable' };
    }
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT proxy_address, logic_contract, admin_contract, block_number, detected_at, updated_at, contract_type FROM proxy_contracts ORDER BY updated_at DESC LIMIT $1 OFFSET $2',
            [Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
        );
        return res.rows;
    } finally {
        client.release();
    }
}

export async function apiGetProxy(address: string) {
    if (!isDatabaseAvailable || !pool) {
        return { error: 'database_unavailable' };
    }
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT proxy_address, logic_contract, admin_contract, block_number, detected_at, updated_at, contract_type FROM proxy_contracts WHERE proxy_address = $1',
            [address.toLowerCase()]
        );
        if (res.rows.length === 0) return null;
        return res.rows[0];
    } finally {
        client.release();
    }
}

export async function apiGetHistory(address: string) {
    if (!isDatabaseAvailable || !pool) {
        return { error: 'database_unavailable' };
    }
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT proxy_address, logic_contract, admin_contract, block_number, detected_at, updated_at, contract_type, upgrade_tx_hash FROM proxy_contracts WHERE proxy_address = $1 ORDER BY detected_at DESC',
            [address.toLowerCase()]
        );
        return res.rows;
    } finally {
        client.release();
    }
}

export async function apiMonitorAdd(address: string) {
    // Normalize address
    let normalized = address;
    try {
        normalized = (ethers as any).getAddress(address);
    } catch {
        return { error: 'invalid_address' };
    }

    // Classify and attach appropriate monitoring
    try {
        await checkProxyType(normalized, 0);
        return { ok: true };
    } catch (e) {
        // Fallback: best-effort add to storage slot monitor if available
        if (storageSlotMonitor) {
            try {
                await storageSlotMonitor.addProxy(normalized);
                return { ok: true, fallback: 'storage_monitor' };
            } catch (e2) {
                return { error: 'monitor_add_failed', detail: e2 instanceof Error ? e2.message : String(e2) };
            }
        }
        return { error: 'monitor_add_failed', detail: e instanceof Error ? e.message : String(e) };
    }
}

export async function apiMonitorRemove(address: string) {
    let normalized = address;
    try {
        normalized = (ethers as any).getAddress(address);
    } catch {
        return { error: 'invalid_address' };
    }

    try {
        if (proxyEventListener) {
            await proxyEventListener.removeListener(normalized);
        }
        if (storageSlotMonitor) {
            storageSlotMonitor.removeProxy(normalized);
        }
        return { ok: true };
    } catch (e) {
        return { error: 'monitor_remove_failed', detail: e instanceof Error ? e.message : String(e) };
    }
}

// ----------------------
// Pair analysis helpers
// ----------------------

async function fetchLatestPairFromDB(): Promise<{ proxy: string; logic: string } | null> {
    if (!isDatabaseAvailable || !pool) {
        console.warn("[analyze] Database is not available; cannot fetch latest pair.");
        return null;
    }
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT proxy_address, logic_contract, detected_at
            FROM proxy_contracts
            WHERE proxy_address IS NOT NULL AND logic_contract IS NOT NULL
            ORDER BY detected_at DESC
            LIMIT 1
        `);
        if (res.rows.length === 0) {
            console.warn("[analyze] No pair records found in proxy_contracts.");
            return null;
        }
        const row = res.rows[0];
        const proxy: string = (row.proxy_address || '').toLowerCase();
        const logic: string = (row.logic_contract || '').toLowerCase();
        console.log(`[analyze] Latest pair from DB: proxy=${proxy} logic=${logic} detected_at=${row.detected_at}`);
        return { proxy, logic };
    } finally {
        client.release();
    }
}

async function analyzeOrFetchSources(address: string): Promise<{ slither: any; sources?: Record<string, string> }> {
    console.log(`[analyze] analyzeContract -> ${address}`);
    try {
        const analysis = await analyzeContract(address);
        if (analysis.status === 'completed' && analysis.parsed) {
            const srcCount = analysis.sources ? Object.keys(analysis.sources).length : 0;
            const nonEmpty = analysis.sources ? Object.values(analysis.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
            console.log(`[analyze] Slither OK for ${address} | sources=${srcCount} nonEmpty=${nonEmpty}`);
            return { slither: analysis.parsed, sources: analysis.sources };
        }
        console.warn(`[analyze] Slither FAILED for ${address} | reason=${(analysis as any)?.rawOutput || 'no_json'} | fallback to explorer`);
    } catch (e: any) {
        console.warn(`[analyze] analyzeContract threw for ${address} | ${e?.message || String(e)}`);
    }
    try {
        const verified = await getVerifiedSource(address);
        const srcCount = Object.keys(verified.sources || {}).length;
        const nonEmpty = Object.values(verified.sources || {}).filter((c: string) => (c || '').trim().length > 0).length;
        console.log(`[analyze] Explorer source fetched for ${address} | files=${srcCount} nonEmpty=${nonEmpty}`);
        return { slither: {}, sources: verified.sources };
    } catch (e: any) {
        console.error(`[analyze] Explorer fetch FAILED for ${address} | ${e?.message || String(e)}`);
        throw e;
    }
}

async function buildPairContext(proxy: string, logic: string): Promise<{ ctx: any; used: 'sources' | 'bytecode' } | null> {
    // Try source-based context first
    try {
        const [proxyData, logicData] = await Promise.all([
            analyzeOrFetchSources(proxy),
            analyzeOrFetchSources(logic),
        ]);
        const proxyNonEmpty = proxyData.sources ? Object.values(proxyData.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
        const logicNonEmpty = logicData.sources ? Object.values(logicData.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
        console.log(`[analyze] Prepared contexts | proxy{ slither=${!!proxyData.slither}, nonEmpty=${proxyNonEmpty} } | logic{ slither=${!!logicData.slither}, nonEmpty=${logicNonEmpty} }`);
        if (proxyNonEmpty > 0 && logicNonEmpty > 0) {
            return {
                ctx: {
                    proxy: { address: proxy, slither: proxyData.slither, sources: proxyData.sources },
                    logic: { address: logic, slither: logicData.slither, sources: logicData.sources },
                },
                used: 'sources',
            };
        }
        console.warn("[analyze] One or both contracts lack non-empty sources; will try bytecode path.");
    } catch {
        // fallthrough to bytecode
    }

    // Fallback to bytecode context
    const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || RPC_URL;
    const bytecodeProvider = new (ethers as any).JsonRpcProvider(rpcUrl);
    const [proxyCode, logicCode] = await Promise.all([
        bytecodeProvider.getCode(proxy),
        bytecodeProvider.getCode(logic),
    ]);
    if (!proxyCode || proxyCode === '0x') {
        console.error('[analyze] No bytecode at proxy address. Aborting analysis.');
        return null;
    }
    if (!logicCode || logicCode === '0x') {
        console.error('[analyze] No bytecode at logic address. Aborting analysis.');
        return null;
    }
    console.log('[analyze] Using bytecode context (NO_SOURCE path).');
    return {
        ctx: {
            proxy: { address: proxy, slither: {}, bytecode: proxyCode },
            logic: { address: logic, slither: {}, bytecode: logicCode },
        },
        used: 'bytecode',
    };
}

async function runSelectedPairDetectors(ctx: any, keys?: string[]): Promise<any[]> {
    const detectors: any[] = selectPairDetectors(keys);
    console.log(`[analyze] Detectors selected: ${detectors.map(d => d.name || 'unknown').join(', ')}`);
    const findings = await runPairDetectors(ctx, detectors as any);
    return findings;
}

async function analyzeLatestPairFromDB(checkKeys?: string[]): Promise<void> {
    const latest = await fetchLatestPairFromDB();
    if (!latest) return;
    const built = await buildPairContext(latest.proxy, latest.logic);
    if (!built) return;
    const findings = await runSelectedPairDetectors(built.ctx, checkKeys);
    console.log(JSON.stringify({ proxy: latest.proxy, logic: latest.logic, sourceMode: built.used, findings }, null, 2));
}

async function analyzePairAddresses(proxy: string, logic: string, checkKeys?: string[]): Promise<void> {
    const built = await buildPairContext(proxy, logic);
    if (!built) {
        const msg = `[analyze] Skipped analysis for ${proxy} -> ${logic} (no sources/bytecode).`;
        console.log(msg);
        try {
            if (isTelegramEnabled()) await sendTelegramAlert(msg);
        } catch {}
        return;
    }
    const findings = await runSelectedPairDetectors(built.ctx, checkKeys);
    const payload = { proxy, logic, sourceMode: built.used, findings };
    console.log(JSON.stringify(payload, null, 2));

    // 将本次实时分析结果导出到在线表格（与批处理使用的 sheet 区分开）
    try {
        const mod = await import('../report/googleSheet');
        if ((mod as any).appendRealtimeAnalysisToSheet) {
            await (mod as any).appendRealtimeAnalysisToSheet({
                proxy,
                logic,
                sourceMode: built.used,
                findings,
            });
        }
    } catch (e: any) {
        console.warn('[analyze] Failed to export realtime analysis to spreadsheet:', e?.message || String(e));
    }

    try {
        if (isTelegramEnabled()) {
            let summary = buildFindingsTelegramMessage(proxy, logic, built.used, findings);

            // 在实时分析的 TG 报告中附上 Google Sheet 链接
            const sheetId = process.env.GOOGLE_SHEETS_ID || process.env.REPORT_SHEET_ID;
            const sheetUrlFromEnv = process.env.GOOGLE_SHEETS_URL;
            const sheetUrl = sheetUrlFromEnv || (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : undefined);
            if (sheetUrl) {
                summary += `\n\nReported to Google Sheet: ${sheetUrl}`;
            }

            await sendTelegramAlert(summary);
        }
    } catch (e) {
        console.warn(`Telegram alert (analysis) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function buildFindingsTelegramMessage(proxy: string, logic: string, mode: 'sources' | 'bytecode', findings: any[]): string {
    const lines: string[] = [];
    lines.push('🔎 Pair Security Analysis Results');
    lines.push(`Proxy: ${proxy}`);
    lines.push(`Logic: ${logic}`);
    lines.push(`Mode: ${mode}`);
    lines.push(`Findings: ${findings.length}`);
    function normalizeSeverityLabel(raw: string | undefined): string {
        const v = String(raw || '').toLowerCase();
        switch (v) {
            case 'critical': return 'HIGH';
            case 'high': return 'HIGH';
            case 'medium': return 'MEDIUM';
            case 'low': return 'LOW';
            case 'info':
            default: return 'INFO';
        }
    }
    const maxLines = 15; // avoid too long message
    for (let i = 0; i < Math.min(findings.length, maxLines); i++) {
        const f = findings[i] || {};
        const sev = normalizeSeverityLabel(f.severity);
        const title = f.title || f.id || 'untitled';
        lines.push(`- [${sev}] ${title}`);
    }
    if (findings.length > maxLines) {
        lines.push(`... and ${findings.length - maxLines} more`);
    }
    return lines.join('\n');
}
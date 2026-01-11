import { ethers } from 'ethers';

/**
 * RPC Manager with automatic failover and retry logic
 * Supports multiple RPC endpoints and switches between them on failures
 */
export class RpcManager {
    private urls: string[];
    private currentIndex: number = 0;
    private providers: Map<string, ethers.JsonRpcProvider> = new Map();
    private failureCounts: Map<string, number> = new Map();
    private lastFailureTime: Map<string, number> = new Map();
    
    // Configuration
    private readonly MAX_FAILURES_BEFORE_SWITCH = 3;
    private readonly FAILURE_RESET_TIME_MS = 60000; // 1 minute
    private readonly MAX_RETRIES_PER_CALL = 5;
    private readonly RETRY_DELAY_MS = 1000;
    private readonly HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
    
    constructor(rpcUrls: string | string[]) {
        // Parse comma-separated URLs or use array
        if (typeof rpcUrls === 'string') {
            this.urls = rpcUrls.split(',').map(url => url.trim()).filter(Boolean);
        } else {
            this.urls = rpcUrls;
        }
        
        if (this.urls.length === 0) {
            throw new Error('❌ RpcManager: No RPC URLs provided');
        }
        
        console.log(`🔗 RpcManager initialized with ${this.urls.length} endpoint(s):`);
        this.urls.forEach((url, idx) => {
            console.log(`   [${idx}] ${url}`);
            this.failureCounts.set(url, 0);
        });
        
        // Start periodic health checks
        this.startHealthCheck();
    }
    
    /**
     * Get the current active provider
     */
    public getProvider(): ethers.JsonRpcProvider {
        const url = this.urls[this.currentIndex];
        if (!this.providers.has(url)) {
            const provider = new ethers.JsonRpcProvider(url);
            this.providers.set(url, provider);
        }
        return this.providers.get(url)!;
    }
    
    /**
     * Get current RPC URL
     */
    public getCurrentUrl(): string {
        return this.urls[this.currentIndex];
    }
    
    /**
     * Switch to the next available RPC endpoint
     */
    private switchToNextEndpoint(): void {
        const oldUrl = this.urls[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.urls.length;
        const newUrl = this.urls[this.currentIndex];
        
        console.warn(`🔄 RpcManager: Switching from endpoint [${oldUrl}] to [${newUrl}]`);
    }
    
    /**
     * Record a failure for the current endpoint
     */
    private recordFailure(url: string, error: any): void {
        const count = (this.failureCounts.get(url) || 0) + 1;
        this.failureCounts.set(url, count);
        this.lastFailureTime.set(url, Date.now());
        
        const errorMsg = error?.message || String(error);
        console.error(`⚠️ RpcManager: Endpoint [${url}] failure #${count}: ${errorMsg}`);
        
        if (count >= this.MAX_FAILURES_BEFORE_SWITCH && this.urls.length > 1) {
            console.warn(`🚨 RpcManager: Endpoint [${url}] reached ${count} failures, switching...`);
            this.switchToNextEndpoint();
        }
    }
    
    /**
     * Reset failure count if enough time has passed
     */
    private maybeResetFailures(url: string): void {
        const lastFailure = this.lastFailureTime.get(url);
        if (lastFailure && Date.now() - lastFailure > this.FAILURE_RESET_TIME_MS) {
            const oldCount = this.failureCounts.get(url) || 0;
            if (oldCount > 0) {
                console.log(`✅ RpcManager: Resetting failure count for [${url}] (was ${oldCount})`);
                this.failureCounts.set(url, 0);
            }
        }
    }
    
    /**
     * Check if an error is retryable (network/RPC related)
     */
    private isRetryableError(error: any): boolean {
        const msg = (error?.message || String(error || '')).toLowerCase();
        const code = error?.code;
        
        // Network errors
        if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
            return true;
        }
        
        // HTTP errors
        if (msg.includes('503') || msg.includes('502') || msg.includes('504') || 
            msg.includes('timeout') || msg.includes('hang up') || 
            msg.includes('network error') || msg.includes('server error')) {
            return true;
        }
        
        // ethers.js specific errors
        if (code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'SERVER_ERROR') {
            return true;
        }
        
        return false;
    }
    
    /**
     * Execute an RPC call with automatic retry and failover
     */
    public async executeWithRetry<T>(
        operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
        operationName: string = 'RPC call'
    ): Promise<T> {
        let lastError: any;
        let attemptCount = 0;
        
        while (attemptCount < this.MAX_RETRIES_PER_CALL) {
            attemptCount++;
            const currentUrl = this.getCurrentUrl();
            
            // Reset failures if enough time has passed
            this.maybeResetFailures(currentUrl);
            
            try {
                const provider = this.getProvider();
                const result = await operation(provider);
                
                // Success! Reset failure count for this endpoint
                if (this.failureCounts.get(currentUrl)! > 0) {
                    console.log(`✅ RpcManager: ${operationName} succeeded on [${currentUrl}], resetting failure count`);
                    this.failureCounts.set(currentUrl, 0);
                }
                
                return result;
            } catch (error: any) {
                lastError = error;
                
                if (!this.isRetryableError(error)) {
                    // Non-retryable error (e.g., contract not found, invalid params)
                    throw error;
                }
                
                this.recordFailure(currentUrl, error);
                
                if (attemptCount < this.MAX_RETRIES_PER_CALL) {
                    const delay = this.RETRY_DELAY_MS * attemptCount;
                    console.log(`⏳ RpcManager: Retrying ${operationName} in ${delay}ms (attempt ${attemptCount + 1}/${this.MAX_RETRIES_PER_CALL})...`);
                    await this.sleep(delay);
                } else {
                    console.error(`❌ RpcManager: ${operationName} failed after ${this.MAX_RETRIES_PER_CALL} attempts`);
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * Convenience method: getCode with retry
     */
    public async getCode(address: string, blockTag?: string | number): Promise<string> {
        return this.executeWithRetry(
            async (provider) => await provider.getCode(address, blockTag),
            `getCode(${address})`
        );
    }
    
    /**
     * Convenience method: getStorageAt with retry
     */
    public async getStorageAt(address: string, position: string | number, blockTag?: string | number): Promise<string> {
        return this.executeWithRetry(
            async (provider) => {
                // Use send method for eth_getStorageAt
                return await provider.send('eth_getStorageAt', [
                    address,
                    typeof position === 'number' ? '0x' + position.toString(16) : position,
                    blockTag || 'latest'
                ]);
            },
            `getStorageAt(${address}, ${position})`
        );
    }
    
    /**
     * Convenience method: getBlock with retry
     */
    public async getBlock(blockHashOrBlockTag: string | number, prefetchTxs?: boolean): Promise<any> {
        return this.executeWithRetry(
            async (provider) => {
                if (prefetchTxs) {
                    return await provider.getBlock(blockHashOrBlockTag, true);
                } else {
                    return await provider.getBlock(blockHashOrBlockTag);
                }
            },
            `getBlock(${blockHashOrBlockTag})`
        );
    }
    
    /**
     * Convenience method: getBlockNumber with retry
     */
    public async getBlockNumber(): Promise<number> {
        return this.executeWithRetry(
            async (provider) => await provider.getBlockNumber(),
            'getBlockNumber()'
        );
    }
    
    /**
     * Convenience method: send raw RPC call with retry
     */
    public async send(method: string, params: any[]): Promise<any> {
        return this.executeWithRetry(
            async (provider) => await provider.send(method, params),
            `send(${method})`
        );
    }
    
    /**
     * Convenience method: call contract with retry
     */
    public async call(transaction: any, blockTag?: string | number): Promise<string> {
        return this.executeWithRetry(
            async (provider) => {
                // In ethers v6, call only takes the transaction object
                // blockTag should be part of the transaction object if needed
                if (blockTag !== undefined && !transaction.blockTag) {
                    transaction = { ...transaction, blockTag };
                }
                return await provider.call(transaction);
            },
            `call(${transaction.to})`
        );
    }
    
    /**
     * Create a proxy provider that delegates calls to the RpcManager
     * This maintains compatibility with existing code that expects a provider
     */
    public createProviderProxy(): any {
        const manager = this;
        const baseProvider = this.getProvider();
        
        return new Proxy(baseProvider, {
            get(target: any, prop: string | symbol) {
                // Intercept key methods to use the retry logic
                if (prop === 'getCode') {
                    return (address: string, blockTag?: string | number) => 
                        manager.getCode(address, blockTag);
                }
                if (prop === 'getStorageAt') {
                    return (address: string, position: string | number, blockTag?: string | number) => 
                        manager.getStorageAt(address, position, blockTag);
                }
                if (prop === 'getBlock') {
                    return (blockHashOrBlockTag: string | number, prefetchTxs?: boolean) => 
                        manager.getBlock(blockHashOrBlockTag, prefetchTxs);
                }
                if (prop === 'getBlockNumber') {
                    return () => manager.getBlockNumber();
                }
                if (prop === 'send') {
                    return (method: string, params: any[]) => 
                        manager.send(method, params);
                }
                if (prop === 'call') {
                    return (transaction: any, blockTag?: string | number) => 
                        manager.call(transaction, blockTag);
                }
                
                // For other properties/methods, delegate to the base provider
                const value = target[prop];
                if (typeof value === 'function') {
                    return value.bind(target);
                }
                return value;
            }
        });
    }
    
    /**
     * Get health status of all endpoints
     */
    public getHealthStatus(): Array<{ url: string; failures: number; active: boolean }> {
        return this.urls.map((url, idx) => ({
            url,
            failures: this.failureCounts.get(url) || 0,
            active: idx === this.currentIndex
        }));
    }
    
    /**
     * Start periodic health check
     */
    private startHealthCheck(): void {
        setInterval(async () => {
            const status = this.getHealthStatus();
            const hasFailures = status.some(s => s.failures > 0);
            
            if (hasFailures) {
                console.log('🏥 RpcManager health check:');
                status.forEach(s => {
                    const icon = s.active ? '✅' : '⚪';
                    const failInfo = s.failures > 0 ? ` (${s.failures} failures)` : '';
                    console.log(`   ${icon} ${s.url}${failInfo}`);
                });
            }
        }, this.HEALTH_CHECK_INTERVAL_MS);
    }
    
    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Create a global RPC manager instance
 */
let globalRpcManager: RpcManager | null = null;

export function initializeRpcManager(rpcUrls?: string | string[]): RpcManager {
    const urls = rpcUrls || process.env.RPC_URL || 'https://rpc.ankr.com/xdc/';
    globalRpcManager = new RpcManager(urls);
    return globalRpcManager;
}

export function getRpcManager(): RpcManager {
    if (!globalRpcManager) {
        globalRpcManager = initializeRpcManager();
    }
    return globalRpcManager;
}


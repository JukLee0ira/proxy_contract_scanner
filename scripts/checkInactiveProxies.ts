import { Pool } from 'pg';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuration
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '20', 10);
const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 3;

// Etherscan API config
const ETHERSCAN_BASE_URL = process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/api';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLastTransactionTime(address: string): Promise<{ timestamp: number | null, error?: string }> {
    const paramsCommon = {
        module: 'account',
        address: address,
        sort: 'desc',
        page: '1',
        offset: '1',
        apikey: ETHERSCAN_API_KEY,
    };

    const getTx = async (action: 'txlist' | 'txlistinternal') => {
        try {
            const response = await axios.get(ETHERSCAN_BASE_URL, {
                params: { ...paramsCommon, action },
                timeout: 10000
            });
            const data = response.data;
            if (data.status === '1' && data.result && data.result.length > 0) {
                return parseInt(data.result[0].timeStamp, 10);
            }
            if (data.message === 'No transactions found') {
                return 0;
            }
            // Rate limit or other error
            if (data.result && typeof data.result === 'string' && data.result.includes('Max rate limit reached')) {
                throw new Error('RATE_LIMIT');
            }
            return null; // Unknown error or empty
        } catch (error: any) {
            if (error.message === 'RATE_LIMIT') throw error;
            console.warn(`[API] Error fetching ${action} for ${address}: ${error.message}`);
            return null;
        }
    };

    try {
        // Fetch both normal and internal transactions
        // We do them sequentially to be nicer to rate limits if running singly, 
        // but parallel is better for performance. 
        // Given free tier limits, let's do sequential with a small pause if needed, or just handle rate limits.
        
        let txTime = await getTx('txlist');
        await sleep(200); // Small delay between calls for same address
        let internalTxTime = await getTx('txlistinternal');

        if (txTime === null && internalTxTime === null) {
             // If both failed (not just empty, but failed/unknown), return error
             // Actually, getTx returns 0 for "No transactions found". 
             // null means error or unexpected response.
             // If one is 0 and other is null, we can probably assume 0 (no txs) for the null one if it was a minor error? 
             // But let's be strict: if we can't confirm, report error.
             return { timestamp: null, error: 'Failed to fetch transactions' };
        }

        const t1 = txTime || 0;
        const t2 = internalTxTime || 0;
        return { timestamp: Math.max(t1, t2) };

    } catch (error: any) {
        if (error.message === 'RATE_LIMIT') {
            await sleep(1000);
            return getLastTransactionTime(address); // Retry once (simple recursion, ideally loop)
        }
        return { timestamp: null, error: error.message };
    }
}

async function main() {
    const dbUrl = process.env.XDC_META_DB_URL || process.env.BATCH_DB_URL || process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('❌ Database URL is not configured.');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: dbUrl });

    try {
        const client = await pool.connect();
        
        // 1. Create table
        console.log('Creating/Checking proxy_inactivity_status table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_inactivity_status (
                address VARCHAR(42) PRIMARY KEY,
                last_tx_timestamp TIMESTAMP,
                is_inactive_1y BOOLEAN,
                check_status VARCHAR(50), -- 'success', 'error', 'no_txs'
                error_message TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        client.release();

        // 2. Fetch addresses from proxy_contracts
        console.log('Fetching proxy addresses...');
        const res = await pool.query('SELECT proxy_address FROM proxy_contracts');
        const proxies = res.rows.map(r => r.proxy_address);
        console.log(`Found ${proxies.length} proxies.`);

        const oneYearAgo = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);

        // 3. Process
        for (let i = 0; i < proxies.length; i++) {
            const address = proxies[i];
            console.log(`[${i + 1}/${proxies.length}] Checking ${address}...`);

            // Check if already checked recently? (Optional, skipping for now as per req)

            let result = await getLastTransactionTime(address);
            
            // Simple retry logic for rate limits if not handled inside
            if (result.error === 'RATE_LIMIT') {
                await sleep(2000);
                result = await getLastTransactionTime(address);
            }

            let checkStatus = 'success';
            let lastTxDate: Date | null = null;
            let isInactive = false;
            let errorMessage = null;

            if (result.timestamp !== null) {
                if (result.timestamp === 0) {
                    checkStatus = 'no_txs';
                    isInactive = true; // No tx ever = inactive
                } else {
                    lastTxDate = new Date(result.timestamp * 1000);
                    isInactive = result.timestamp < oneYearAgo;
                }
            } else {
                checkStatus = 'error';
                errorMessage = result.error || 'Unknown error';
                console.warn(`  ⚠️ Could not check: ${errorMessage}`);
            }

            // Save to DB
            const upsertQuery = `
                INSERT INTO proxy_inactivity_status (address, last_tx_timestamp, is_inactive_1y, check_status, error_message, updated_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (address) DO UPDATE SET
                    last_tx_timestamp = EXCLUDED.last_tx_timestamp,
                    is_inactive_1y = EXCLUDED.is_inactive_1y,
                    check_status = EXCLUDED.check_status,
                    error_message = EXCLUDED.error_message,
                    updated_at = NOW();
            `;
            
            await pool.query(upsertQuery, [
                address, 
                lastTxDate, 
                isInactive, 
                checkStatus, 
                errorMessage
            ]);

            if (checkStatus === 'success' || checkStatus === 'no_txs') {
                console.log(`  ✅ Last Tx: ${lastTxDate ? lastTxDate.toISOString() : 'None'} | Inactive > 1y: ${isInactive}`);
            }

            // Rate limit throttle
            await sleep(250); 
        }

    } catch (e) {
        console.error('Runtime error:', e);
    } finally {
        await pool.end();
    }
}

main();


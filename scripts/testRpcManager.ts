#!/usr/bin/env node
/**
 * Test script for RPC Manager
 * Tests failover and retry functionality
 */

import { initializeRpcManager } from '../src/utils/rpcManager';

async function testRpcManager() {
    console.log('🧪 Testing RPC Manager...\n');
    
    // Test with multiple endpoints (including potentially problematic ones)
    const rpcUrls = process.env.RPC_URL || 'http://158.255.6.148:8989,http://194.180.206.218:8989';
    console.log(`📋 Using RPC URLs: ${rpcUrls}\n`);
    
    const rpcManager = initializeRpcManager(rpcUrls);
    
    try {
        // Test 1: Get block number
        console.log('\n🧪 Test 1: Getting current block number...');
        const blockNumber = await rpcManager.getBlockNumber();
        console.log(`✅ Current block number: ${blockNumber}`);
        
        // Test 2: Get block details
        console.log('\n🧪 Test 2: Getting block details...');
        const block = await rpcManager.getBlock(blockNumber);
        console.log(`✅ Block ${blockNumber} has ${block?.transactions?.length || 0} transactions`);
        
        // Test 3: Get code (test with a known contract)
        const testAddress = '0x3c2269811836af69497E5F486A85D7316753cf62';
        console.log(`\n🧪 Test 3: Getting contract code for ${testAddress}...`);
        const code = await rpcManager.getCode(testAddress);
        console.log(`✅ Code length: ${code.length} characters`);
        
        // Test 4: Get storage
        const eip1967Slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
        console.log(`\n🧪 Test 4: Reading storage slot ${eip1967Slot.slice(0, 10)}...`);
        const storage = await rpcManager.getStorageAt(testAddress, eip1967Slot);
        console.log(`✅ Storage value: ${storage}`);
        
        // Show health status
        console.log('\n📊 RPC Manager Health Status:');
        const health = rpcManager.getHealthStatus();
        health.forEach(h => {
            const icon = h.active ? '✅' : '⚪';
            const failInfo = h.failures > 0 ? ` (${h.failures} failures)` : '';
            console.log(`   ${icon} ${h.url}${failInfo}`);
        });
        
        console.log('\n✅ All tests passed!');
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        process.exit(1);
    }
}

testRpcManager().then(() => {
    console.log('\n🎉 RPC Manager test completed successfully!');
    process.exit(0);
}).catch((error) => {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
});


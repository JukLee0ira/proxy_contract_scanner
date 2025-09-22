# Proxy Scanner Connectivity Tests

This directory contains Jest-based connectivity tests for the Proxy Scanner application to verify that all required components are properly configured and accessible.

## Test Files

### `connectivity.test.ts`
Main Jest test suite organized into three test groups:

1. **RPC Node Connection Tests** - Verifies connection to Ethereum RPC node
2. **Database Connection Tests** - Verifies PostgreSQL database connectivity  
3. **Bytecode Analysis Tests** - Verifies core bytecode analysis functionality

## Running Tests

### Prerequisites
1. Make sure you have Node.js and npm installed
2. Install project dependencies: `npm install --legacy-peer-deps`
3. The `.env` file in the project root contains the configuration for RPC and database connections

### Run All Tests
```bash
npm test
```

### Run Connectivity Tests Only
```bash
npm run test:connectivity
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run Tests with Coverage Report
```bash
npm run test:coverage
```

### Run Tests with Verbose Output
```bash
npx jest --verbose
```

## Test Details

### Test 1: RPC Node Connection
- ✅ Connects to the specified RPC endpoint
- ✅ Retrieves network information (chain ID, name)
- ✅ Gets latest block number and details
- ✅ Tests `eth_getCode` method (required for bytecode analysis)

**Expected Output:**
```
 PASS  test/connectivity.test.ts
   Proxy Scanner Connectivity Tests
     RPC Node Connection
       ✓ should connect to RPC node and retrieve network info
       ✓ should get latest block number
       ✓ should retrieve block details
       ✓ should support eth_getCode method
       ✓ should support eth_getStorageAt method
```

### Test 2: Database Connection
- ✅ Establishes PostgreSQL connection
- ✅ Tests basic queries (SELECT NOW(), version())
- ✅ Checks for existing tables
- ✅ Tests table creation, insert, and select operations
- ✅ Cleans up test data

**Expected Output:**
```
     Database Connection
       ✓ should connect to PostgreSQL database
       ✓ should retrieve PostgreSQL version info
       ✓ should create and manage test tables
       ✓ should handle database connection errors gracefully
```

**Note:** If database is not available, the test will fail but the proxy scanner can still run without database functionality.

### Test 3: Bytecode Analysis
- ✅ Tests bytecode analysis functions
- ✅ Analyzes real contract addresses from recent blocks
- ✅ Tests DELEGATECALL opcode detection
- ✅ Tests EIP-1967 storage slot queries

**Expected Output:**
```
     Bytecode Analysis Functions
       ✓ should parse bytecode correctly
       ✓ should handle empty bytecode
       ✓ should check bytecode for DELEGATECALL opcode
       ✓ should analyze real contract addresses from recent blocks
       ✓ should test EIP-1967 storage slot queries
```

## Test Results

The test suite will display a summary at the end:

```
Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
Snapshots:   0 total
Time:        5.234 s
Ran all test suites.
```

## Jest Features

### Helper Functions
The test suite includes helper functions for Ethereum-specific validation:
- `isValidEthereumAddress()` - Validates Ethereum address format
- `isValidBlockNumber()` - Validates block number format

### Test Configuration
- **Timeout**: 30 seconds for network operations
- **Environment**: Node.js environment
- **Coverage**: Collects coverage from `src/**/*.ts`
- **Setup**: Automatic environment and Jest configuration

## Troubleshooting

### Common Issues

1. **RPC Connection Failed**
   - Check if your RPC URL in `.env` is correct and accessible
   - Verify network connectivity
   - Try alternative RPC providers (Infura, Alchemy, etc.)

2. **Database Connection Failed**
   - Verify PostgreSQL is running
   - Check database credentials in the existing `.env` file
   - Ensure database exists and user has proper permissions
   - Note: Database is optional - scanner can run without it

3. **Bytecode Analysis Failed**
   - Usually indicates RPC connection issues
   - Check if the RPC node supports required methods (`eth_getCode`, `eth_getStorageAt`)
   - Verify block numbers are available

### Tips
- Run tests before starting the main proxy scanner
- Check logs for detailed error messages
- Database connectivity is optional but recommended for persistence
- RPC connectivity is essential for the scanner to function
- Configuration is already set in the existing `.env` file

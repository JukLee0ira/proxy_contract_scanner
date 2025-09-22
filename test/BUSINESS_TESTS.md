# Proxy Scanner Business Logic Tests

This file contains comprehensive end-to-end tests for the Proxy Scanner's core business functionality. These tests deploy real contracts using Hardhat and verify the complete scanning workflow.

## Test Overview

### Test Structure
The business tests are organized into 5 main test suites:

1. **Proxy Contract Detection** - Core detection algorithms
2. **Database Integration** - Data persistence functionality  
3. **Upgrade Event Detection** - Real-time upgrade monitoring
4. **Upgrade Event Database Integration** - Upgrade event persistence
5. **End-to-End Scanner Simulation** - Complete workflow simulation

## Test Scenarios

### 1. Proxy Contract Detection Tests

#### 🔍 **Bytecode Analysis**
- ✅ Detects DELEGATECALL opcode (0xf4) in proxy contracts
- ✅ Verifies logic contracts do NOT contain DELEGATECALL
- ✅ Extracts logic and admin contract addresses from EIP-1967 storage slots

**Tested Features:**
- `compareOpcodes()` function
- `checkBytecodeForOpcode()` function
- EIP-1967 storage slot reading (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`)

### 2. Database Integration Tests

#### 💾 **Data Persistence**
- ✅ Saves proxy contract information to PostgreSQL
- ✅ Handles duplicate prevention correctly
- ✅ Maintains data integrity and relationships

**Database Schema Tested:**
```sql
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
);
```

### 3. Upgrade Event Detection Tests

#### 🔄 **Real-time Monitoring**
- ✅ Detects `Upgraded(address indexed newImplementation)` events
- ✅ Captures transaction hash and block number
- ✅ Verifies storage updates after upgrade
- ✅ Tests proxy functionality with new logic contract

**Contracts Used:**
- `Proxy1967.sol` - EIP-1967 compliant proxy
- `LogicV1.sol` - Initial implementation (version V1)
- `LogicV2.sol` - Upgraded implementation (version V2, adds `add()` function)

### 4. Upgrade Event Database Integration

#### 📊 **Event Persistence**
- ✅ Saves upgrade events with transaction hash
- ✅ Maintains upgrade history for each proxy
- ✅ Tracks multiple logic contract versions per proxy

**Sample Database Records:**
```
proxy_address                              | logic_contract                             | upgrade_tx_hash
0x348f858e2b92f72cfe43396e5090c3f0c205a060 | 0xd02d7247a68432c1a1975ba51be2d610b185951d | (initial deployment)
0x348f858e2b92f72cfe43396e5090c3f0c205a060 | 0x7428d2fbb0609636ee7791c7ff0d612d1089e66a | 0xabc123...
```

### 5. End-to-End Scanner Simulation

#### 🔄 **Complete Workflow**
Simulates the complete scanner workflow:

1. **Discovery Phase**
   - Scans block for contract addresses
   - Checks bytecode for DELEGATECALL opcode
   
2. **Analysis Phase**
   - Extracts EIP-1967 storage values
   - Validates proxy and logic contract addresses
   
3. **Persistence Phase**
   - Saves proxy contract data to database
   - Handles duplicates and data integrity
   
4. **Verification Phase**
   - Confirms data accuracy in database
   - Validates complete workflow execution

## Running the Tests

### Prerequisites
1. **Contracts must be compiled:**
   ```bash
   npx hardhat compile
   ```

2. **Database must be running:**
   - PostgreSQL instance available
   - Credentials configured in `.env` file

3. **Test network configured:**
   - RPC endpoint available in `.env`
   - Private key with sufficient funds

### Test Commands

```bash
# Run business logic tests only
npm run test:business

# Run with verbose output
npx jest test/business.test.ts --verbose

# Run with coverage
npx jest test/business.test.ts --coverage

# Run all tests (connectivity + business)
npm run test:all
```

## Test Environment

### Network Configuration
- Uses configured test network from `.env`
- Deploys fresh contracts for each test run
- Requires gas for contract deployments and transactions

### Database Configuration
- Creates fresh `proxy_contracts` table for each test run
- Automatically cleans up after tests
- Tests database error handling

## Expected Output

### Successful Test Run
```
 PASS  test/business.test.ts (45.234s)
  Proxy Scanner Business Logic Tests
    1. Proxy Contract Detection
      ✓ should detect proxy contract by DELEGATECALL bytecode (2341ms)
      ✓ should verify logic contract does not contain DELEGATECALL (1567ms)
      ✓ should extract proxy and logic contract addresses from storage (1876ms)
    2. Database Integration
      ✓ should save proxy contract to database correctly (2109ms)
      ✓ should handle duplicate proxy contracts correctly (1234ms)
    3. Upgrade Event Detection
      ✓ should detect upgrade event when proxy is upgraded (4567ms)
      ✓ should verify proxy functionality after upgrade (2890ms)
    4. Upgrade Event Database Integration
      ✓ should save upgrade event to database (1987ms)
      ✓ should track upgrade history correctly (1456ms)
    5. End-to-End Scanner Simulation
      ✓ should simulate complete scanner workflow (3211ms)

Test Suites: 1 passed, 1 total
Tests: 10 passed, 10 total
```

### Console Output Examples
```
🚀 Deployed contracts:
   LogicV1: 0x5FbDB2315678afecb367f032d93F642f64180aa3
   LogicV2: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
   Proxy: 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0

✅ Proxy contract 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 contains DELEGATECALL: true
✅ Logic contract 0x5FbDB2315678afecb367f032d93F642f64180aa3 does not contain DELEGATECALL: false

✅ Detected upgrade event:
   New implementation: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
   Transaction hash: 0xabc123def456...
   Block number: 4

🔍 Simulating scanner workflow for block 5
✅ Step 1: Found DELEGATECALL in 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
✅ Step 2: Extracted logic contract: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
✅ Step 3: Saved to database with ID: 3
✅ Step 4: Verified data integrity
✅ Scanner workflow completed successfully!
```

## Key Features Tested

### ✅ Proxy Detection
- EIP-1967 standard compliance
- DELEGATECALL bytecode analysis
- Storage slot extraction

### ✅ Database Operations
- CRUD operations
- Duplicate handling
- Data integrity
- Transaction history

### ✅ Event Monitoring
- Real-time event detection
- Event data extraction
- Storage verification

### ✅ Upgrade Tracking
- Version history
- Transaction correlation
- State verification

### ✅ Error Handling
- Invalid addresses
- Database failures
- Network issues
- Contract interactions

## Troubleshooting

### Common Issues

1. **Contract Deployment Fails**
   - Check gas settings in `.env`
   - Verify account has sufficient funds
   - Ensure network is accessible

2. **Database Connection Issues**
   - Verify PostgreSQL is running
   - Check credentials in `.env`
   - Ensure database exists

3. **Test Timeouts**
   - Network congestion may cause delays
   - Increase Jest timeout if needed
   - Check RPC endpoint responsiveness

4. **Event Detection Fails**
   - Verify event signatures match contract
   - Check transaction confirmation
   - Ensure proper event filtering

### Debug Tips
- Enable verbose logging: `--verbose`
- Check console output for contract addresses
- Verify database state manually if needed
- Use block explorer to verify transactions

# Proxy Scanner

A comprehensive Ethereum proxy contract scanner and monitoring tool with Hardhat support for testing and development.

## Features

- **Real-time Proxy Detection**: Monitors blockchain for proxy contracts using bytecode analysis
- **EIP-1967 Support**: Detects standard proxy patterns with logic and admin contracts
- **Event Monitoring**: Tracks upgrade events for discovered proxy contracts
- **Database Integration**: Optional PostgreSQL support for persistent storage
- **Hardhat Integration**: Smart contract testing and deployment capabilities
- **Configurable**: Flexible configuration system for different networks and environments

## Project Structure

```
proxy_scanner/
├── src/
│   ├── config/
│   │   └── app.ts          # Application configuration
│   └── demo/
│       └── proxyScannerDemo.ts  # Proxy scanner demo
├── contracts/              # Smart contracts for testing
├── test/                   # Hardhat tests
├── package.json
├── tsconfig.json
├── hardhat.config.ts
└── README.md
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Network and Database

#### RPC Configuration
Create a `.env` file and configure your RPC endpoint:

```bash
# Ethereum RPC Configuration
RPC_URL=https://erpc.apothem.network/
PRIVATE_KEY=<your-private-key>

```

You can also set it directly through environment variables, or modify the default values in the code. The system uses `http://localhost:8547` by default.

**Note**: For more complex network configuration (like WebSocket endpoint, chainId, etc.), you can edit the `DEFAULT_CONFIG` object in the `src/config/app.ts` file.

#### Database Configuration (Optional)
Create a `.env` file and configure PostgreSQL connection (if PostgreSQL is not available, the system will automatically skip database functions):

```bash
# PostgreSQL Database Configuration (Optional)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mydb
DB_USER=dbuser
DB_PASSWORD=dbpass
```

#### Database Table Structure
If database is available, the system will automatically create the following table structure:

```sql
CREATE TABLE proxy_contracts (
    proxy_address VARCHAR(42) PRIMARY KEY,
    logic_contract VARCHAR(42),
    admin_contract VARCHAR(42),
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    block_number BIGINT,
    contract_type VARCHAR(50) DEFAULT 'unknown'
);
```

### 3. Run Demo

#### Real-time Monitoring Mode
```bash
npm start
# or
npx ts-node src/demo/proxyScannerDemo.ts
```

#### Other Available Commands
```bash
# Build project
npm run build

# Development mode with auto-restart
npm run dev

# Range scan mode
npm run scan

# Hardhat commands
npm run hardhat:compile
npm run hardhat:test

# Test the project
npm test
```
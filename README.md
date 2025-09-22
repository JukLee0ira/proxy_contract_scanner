# Upgradable Contract Detection System

This is a system that monitors the Ethereum blockchain and automatically detects upgradable contracts (proxy contracts).


## Project Structure

```
proxy_demo/
├── src/
│   ├── config/
│   │   └── app.ts          # Application configuration
│   └── demo/
│       └── proxyScannerDemo.ts  # Proxy scanner demo
├── package.json
├── tsconfig.json
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
RPC_URL=http://localhost:8547
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
npx ts-node src/demo/proxyScannerDemo.ts
```

#### Other Available Commands
```bash
# Build project
npm run build

# Development mode
npm run dev

# Test scanner
npm run test:scanner

# Range scan mode
npm run scan:range
```
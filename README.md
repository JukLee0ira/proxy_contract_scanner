# Proxy Scanner

A comprehensive Ethereum proxy contract scanner and monitoring tool with Hardhat support for testing and development.

## Features

- **Real-time Proxy Detection**: Monitors blockchain for proxy contracts using bytecode analysis
- **EIP-1967 Support**: Detects standard proxy patterns with logic and admin contracts
- **Event Monitoring**: Tracks upgrade events for discovered proxy contracts
- **Security Analysis**: Automated vulnerability detection with multiple analysis modes
- **HTTP API**: RESTful API for querying scanner status and proxy contract data
- **Database Integration**: Optional PostgreSQL support for persistent storage
- **Telegram Alerts**: Real-time notifications for proxy discoveries and upgrades
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

### 3. Configure Telegram Alerts (Optional)

```bash
# Telegram Bot Configuration (Optional)
TG_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

### 4. Run Scanner

#### Mode 1: Listen Only (Default Mode)
```bash
npx ts-node src/demo/proxyScannerDemo.ts
```
- **Behavior**: Pure monitoring mode. The tool starts and listens for new contracts and upgrade events on the blockchain. Only performs discovery and recording (e.g., saving to database), **without executing any security checks**.

#### Mode 2: Listen & Analyze
```bash
npx ts-node src/demo/proxyScannerDemo.ts --mode=listen-analyze
```
- **Behavior**: Monitoring with analysis. Starts listeners and **automatically triggers all** available security checks when new events are discovered.
- If source code is available (Slither or Explorer successful) → Uses source code context to run all pair detectors
- If source code unavailable → Falls back to bytecode analysis (requires RPC access to bytecode)
- Detector suite includes: `hello-pair`, `upgrade-governance`, `storage-collision`, `initializer_mistakes`, `mixing_patterns`

#### Mode 3: Listen & Analyze with Specific Checks
```bash
npx ts-node src/demo/proxyScannerDemo.ts --mode=listen-analyze --checks=storage-collision,uninitialized-impl
```
- **Behavior**: Same as Mode 2 but only runs specified security checks

#### List Available Security Checks
```bash
npx ts-node src/demo/proxyScannerDemo.ts --list-checks
```
**Example Output:**
```
Available Checks:
- storage-collision:  Detects proxy/implementation storage slot collisions.
- uninitialized-impl: Checks for uninitialized implementation contracts.
- admin-privilege:    Analyzes admin access control vulnerabilities.
- mixing-patterns:    Detects EIP-1967 beacon-style initializer mixing patterns (Teller-style risks).
```

### 5. HTTP API Usage

The scanner provides a RESTful API for querying status and proxy contract data:

#### Get Scanner Status
```bash
GET /status
```
Returns overall scanner status for health checks and monitoring.

**Example Response:**
```json
{
  "db": { "available": true },
  "listener": { "current": 12, "max": 50, "available": 38 },
  "storageMonitor": { "monitoredCount": 3, "isRunning": true, "checkInterval": 30000 },
  "queue": { "length": 5 },
  "concurrency": { "activeBlockScans": 1, "pendingBlocks": 2 },
  "rpc": "http://localhost:8547"
}
```

#### Get Monitored Contracts
```bash
GET /monitored
```
Returns list of currently monitored proxy contract addresses.

**Example Response:**
```json
{
  "eventListener": ["0x1234...", "0x5678..."],
  "storageMonitor": ["0xabcd...", "0xefgh..."]
}
```

#### Get Proxy Contracts (Paginated)
```bash
GET /proxies?limit=50&offset=0
```
Returns paginated list of discovered proxy contracts from database.

**Parameters:**
- `limit` (optional): Default 50, max recommended 200
- `offset` (optional): Default 0

**Example Response:**
```json
[
  {
    "proxy_address": "0x1234...",
    "logic_contract": "0x5678...",
    "admin_contract": "0x9abc...",
    "block_number": 12345678,
    "detected_at": "2023-01-01T12:00:00Z",
    "updated_at": "2023-01-01T12:00:00Z",
    "contract_type": "eip1967"
  }
]
```

#### Get Specific Proxy Contract
```bash
GET /proxies/{address}
```
Returns information for a specific proxy contract.

**Example Response:**
```json
{
  "proxy_address": "0x1234...",
  "logic_contract": "0x5678...",
  "admin_contract": "0x9abc...",
  "block_number": 12345678,
  "detected_at": "2023-01-01T12:00:00Z",
  "updated_at": "2023-01-01T12:00:00Z",
  "contract_type": "eip1967"
}
```

#### Get Proxy History
```bash
GET /history?address=0x1234...
```
Returns all version records for a specific proxy contract (ordered by detected_at descending).

**Example Response:**
```json
[
  {
    "proxy_address": "0x1234...",
    "logic_contract": "0x5678...",
    "upgrade_tx_hash": "0xabcd...",
    "block_number": 12345680,
    "detected_at": "2023-01-02T12:00:00Z"
  },
  {
    "proxy_address": "0x1234...",
    "logic_contract": "0x1111...",
    "upgrade_tx_hash": "",
    "block_number": 12345678,
    "detected_at": "2023-01-01T12:00:00Z"
  }
]
```


## Security Analysis

The scanner includes multiple security detectors:

- **Storage Collision**: Detects proxy/implementation storage slot conflicts
- **Uninitialized Implementation**: Checks for uninitialized implementation contracts  
- **Admin Privilege**: Analyzes admin access control vulnerabilities
- **Upgrade Governance**: Tests upgrade function protection

Analysis modes:
- **Source Code Analysis**: When contract source is available via Slither or block explorers
- **Bytecode Analysis**: Fallback mode using on-chain bytecode when source unavailable

### 6. Other Available Commands
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
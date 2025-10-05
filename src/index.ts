import { createApiServer } from './api/server';
import './demo/proxyScannerDemo';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function start() {
    const app = createApiServer();
    app.listen(PORT, () => {
        console.log(`HTTP API listening on http://localhost:${PORT}`);
    });
}

start().catch((err) => {
    console.error('Failed to start API server:', err);
    process.exit(1);
});



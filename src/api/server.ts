import express, { Request, Response } from 'express';
import cors from 'cors';
import { apiGetStatus, apiGetMonitored, apiListProxies, apiGetProxy, apiGetHistory, apiMonitorAdd, apiMonitorRemove } from '../demo/proxyScannerDemo';
import { isTelegramEnabled } from '../alert/telegram';

export function createApiServer() {
    const app = express();
    app.use(express.json());
    app.use(cors());

    app.get('/status', (_req: Request, res: Response) => {
        const status = apiGetStatus();
        return res.json({
            ...status,
            alerts: { telegram: isTelegramEnabled() }
        });
    });

    app.get('/monitored', (_req: Request, res: Response) => {
        return res.json(apiGetMonitored());
    });

    app.get('/proxies', async (req: Request, res: Response) => {
        const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
        const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;
        const result = await apiListProxies(limit, offset);
        return res.json(result);
    });

    app.get('/proxies/:address', async (req: Request, res: Response) => {
        const address = req.params.address;
        const result = await apiGetProxy(address);
        if (!result || (result as any).error) return res.status(404).json(result ?? { error: 'not_found' });
        return res.json(result);
    });

    app.get('/history', async (req: Request, res: Response) => {
        const address = String(req.query.address || '').trim();
        if (!address) return res.status(400).json({ error: 'address_required' });
        const result = await apiGetHistory(address);
        if ((result as any)?.error) return res.status(503).json(result);
        return res.json(result);
    });

    app.post('/monitor', async (req: Request, res: Response) => {
        const address = String((req.body && (req.body as any).address) || '').trim();
        if (!address) return res.status(400).json({ error: 'address_required' });
        const result = await apiMonitorAdd(address);
        if ((result as any)?.error) return res.status(400).json(result);
        return res.json(result);
    });

    app.delete('/monitor/:address', async (req: Request, res: Response) => {
        const address = req.params.address;
        const result = await apiMonitorRemove(address);
        if ((result as any)?.error) return res.status(400).json(result);
        return res.json(result);
    });

    return app;
}



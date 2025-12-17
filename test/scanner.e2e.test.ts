import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import axios from "axios";
import path from "path";

const RPC_URL = process.env.RPC_URL || "https://earpc.apothem.network/";
const PROJECT_ROOT = path.resolve(__dirname, "..");

async function waitForStatus(baseURL: string, timeoutMs = 20_000): Promise<any> {
  const started = Date.now();
  let lastError: any = null;
  // 每 1 秒轮询一次 /status，直到成功或超时
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await axios.get(`${baseURL}/status`, { timeout: 3_000 });
      return res.data;
    } catch (e: any) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw lastError ?? new Error("等待 /status 超时");
}

describe("Scanner 端到端（通过 src/index.ts 启动）", () => {
  let proc: ChildProcessWithoutNullStreams | null = null;
  const PORT = 3100;
  const baseURL = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    // 通过 ts-node 启动完整的 HTTP API + scanner
    proc = spawn(
      path.resolve(PROJECT_ROOT, "node_modules/.bin/ts-node"),
      ["src/index.ts"],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PORT: String(PORT),
          RPC_URL,
          MODE: "listen-analyze",
          // 端到端测试中一般不需要 Telegram 告警
          DISABLE_DISCOVERY_TELEGRAM: "1",
        },
      }
    );

    // 如果进程在启动阶段就退出，直接抛错
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`scanner 进程退出，exit code=${code}`);
      }
    });

    // 等待 /status 就绪
    await waitForStatus(baseURL);
  }, 25_000);

  afterAll(async () => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });

  it("应能返回运行状态并指向正确的 RPC_URL", async () => {
    const res = await axios.get(`${baseURL}/status`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("db");
    expect(res.data).toHaveProperty("listener");
    expect(res.data).toHaveProperty("storageMonitor");
    expect(res.data).toHaveProperty("queue");
    expect(res.data).toHaveProperty("concurrency");
    expect(res.data).toHaveProperty("rpc");
    expect(res.data.rpc).toBe(RPC_URL);
  });
});



import { expect } from "chai";
import axios from "axios";
import http from "http";
import { createApiServer } from "../src/api/server";

describe("HTTP API (server.ts)", function () {
    let server: http.Server;
    let baseURL: string;

    before(async () => {
        const app = createApiServer();
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve());
        });
        const addressInfo = server.address();
        const port = typeof addressInfo === "string" ? 80 : (addressInfo?.port ?? 3000);
        baseURL = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    describe("Status API", () => {
        it("GET /status should return scanner runtime status", async () => {
            const res = await axios.get(`${baseURL}/status`);
            expect(res.status).to.equal(200);
            expect(res.data).to.have.property("db");
            expect(res.data.db).to.have.property("available");
            expect(res.data).to.have.property("listener");
            expect(res.data).to.have.property("storageMonitor");
            expect(res.data).to.have.property("queue");
            expect(res.data).to.have.property("concurrency");
            expect(res.data).to.have.property("rpc");
        });
    });

    describe("Monitored API", () => {
        it("GET /monitored should list in-memory monitored addresses", async () => {
            const res = await axios.get(`${baseURL}/monitored`);
            expect(res.status).to.equal(200);
            expect(res.data).to.have.property("eventListener");
            expect(res.data).to.have.property("storageMonitor");
            expect(res.data.eventListener).to.be.an("array");
            expect(res.data.storageMonitor).to.be.an("array");
        });
    });

    describe("Proxies API (DB-backed)", () => {
        it("GET /proxies should respond based on DB availability", async () => {
            const res = await axios.get(`${baseURL}/proxies?limit=1&offset=0`);
            expect(res.status).to.equal(200);
            if (res.data && res.data.error) {
                expect(res.data.error).to.equal("database_unavailable");
            } else {
                expect(Array.isArray(res.data)).to.equal(true);
            }
        });

        it("GET /proxies/:address should 404 with not_found or database_unavailable", async () => {
            try {
                await axios.get(`${baseURL}/proxies/0x0000000000000000000000000000000000000001`);
                expect.fail("expected 404");
            } catch (e: any) {
                expect(e.response?.status).to.equal(404);
                expect(e.response?.data).to.have.property("error");
                expect(["not_found", "database_unavailable"]).to.include(e.response.data.error);
            }
        });

        it("GET /history requires address and returns 400 when missing", async () => {
            try {
                await axios.get(`${baseURL}/history`);
                expect.fail("expected 400");
            } catch (e: any) {
                expect(e.response?.status).to.equal(400);
                expect(e.response?.data).to.have.property("error").that.equals("address_required");
            }
        });

        it("GET /history should 200 with list or 503 when DB unavailable", async () => {
            const addr = "0x0000000000000000000000000000000000000001";
            try {
                const res = await axios.get(`${baseURL}/history`, { params: { address: addr } });
                expect(res.status).to.equal(200);
                expect(Array.isArray(res.data)).to.equal(true);
            } catch (e: any) {
                expect(e.response?.status).to.equal(503);
                expect(e.response?.data).to.have.property("error").that.equals("database_unavailable");
            }
        });
    });

    describe("Monitor management", () => {
        it("POST /monitor should 400 on invalid address", async () => {
            try {
                await axios.post(`${baseURL}/monitor`, { address: "not_an_address" });
                expect.fail("expected 400");
            } catch (e: any) {
                expect(e.response?.status).to.equal(400);
                expect(e.response?.data).to.have.property("error").that.equals("invalid_address");
            }
        });

        it("POST /monitor should return ok when monitoring available, else 400", async () => {
            const addr = "0x0000000000000000000000000000000000000001";
            try {
                const res = await axios.post(`${baseURL}/monitor`, { address: addr });
                expect(res.status).to.equal(200);
                expect(res.data).to.have.property("ok").that.equals(true);
            } catch (e: any) {
                expect(e.response?.status).to.equal(400);
                expect(e.response?.data).to.have.property("error").that.equals("monitor_add_failed");
            }
        });

        it("DELETE /monitor/:address should 400 on invalid address", async () => {
            try {
                await axios.delete(`${baseURL}/monitor/not_an_address`);
                expect.fail("expected 400");
            } catch (e: any) {
                expect(e.response?.status).to.equal(400);
                expect(e.response?.data).to.have.property("error").that.equals("invalid_address");
            }
        });

        it("DELETE /monitor/:address should succeed even if not monitored", async () => {
            const res = await axios.delete(`${baseURL}/monitor/0x0000000000000000000000000000000000000001`);
            expect(res.status).to.equal(200);
            expect(res.data).to.have.property("ok").that.equals(true);
        });
    });
});



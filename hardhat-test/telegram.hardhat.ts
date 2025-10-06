import { expect } from "chai";
import * as telegram from "../src/alert/telegram";
import axios from "axios";

describe("Alert: Telegram", function () {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // restore env
        process.env = { ...originalEnv } as any;
    });

    it("isTelegramEnabled should be false when env missing", () => {
        delete process.env.TG_BOT_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
        delete process.env.TELEGRAM_CHAT_IDS;
        delete process.env.TG_CHAT_ID;
        expect(telegram.isTelegramEnabled()).to.equal(false);
    });

    it("isTelegramEnabled should be true when token and chat ids present", () => {
        process.env.TG_BOT_TOKEN = "test-token";
        process.env.TELEGRAM_CHAT_ID = "12345,67890";
        expect(telegram.isTelegramEnabled()).to.equal(true);
    });

    it("buildUpgradeAlertMessage should format message fields correctly", () => {
        const msg = telegram.buildUpgradeAlertMessage({
            proxyAddress: "0xProxy",
            newImplementation: "0xImpl",
            blockNumber: 123,
            txHash: "0xhash",
            detection: "event",
        } as any);
        expect(msg).to.contain("Proxy: 0xProxy");
        expect(msg).to.contain("New Impl: 0xImpl");
        expect(msg).to.contain("Block: 123");
        expect(msg).to.contain("Tx: 0xhash");
        expect(msg).to.contain("Detection: event");
    });

    it("sendTelegramAlert should no-op when disabled", async () => {
        delete process.env.TG_BOT_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
        let called = false;
        const spy = (axios as any).post;
        (axios as any).post = async () => { called = true; };
        try {
            await telegram.sendTelegramAlert("test");
            expect(called).to.equal(false);
        } finally {
            (axios as any).post = spy;
        }
    });

    it("sendTelegramAlert should call axios.post once per chat id", async () => {
        process.env.TG_BOT_TOKEN = "test-token";
        process.env.TELEGRAM_CHAT_ID = "111,222,333";

        let calls: any[] = [];
        const spy = (axios as any).post;
        (axios as any).post = async (url: string, body: any) => {
            calls.push({ url, body });
            return { status: 200, data: { ok: true } };
        };
        try {
            await telegram.sendTelegramAlert("hello");
            expect(calls.length).to.equal(3);
            for (const c of calls) {
                expect(c.url).to.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage/);
                expect(c.body).to.have.property("chat_id");
                expect(c.body).to.have.property("text").that.equals("hello");
            }
        } finally {
            (axios as any).post = spy;
        }
    });
});



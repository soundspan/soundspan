import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";

jest.unmock("axios");
jest.mock("../../metrics", () => ({ recordFederationSyncSkip: jest.fn() }));
jest.mock("../../utils/logger", () => ({
    logger: { child: jest.fn(() => ({ warn: jest.fn() })) },
}));

import {
    createFederationClient,
    FederationHttpError,
} from "../federationClient";

interface ConnectRequest {
    method: string | undefined;
    target: string | undefined;
}

interface ProxyState {
    connectRequests: ConnectRequest[];
    connections: number;
}

interface ProxyEnvSnapshot {
    httpsProxy: string | undefined;
    lowerHttpsProxy: string | undefined;
    noProxy: string | undefined;
    lowerNoProxy: string | undefined;
}

async function listenOnLoopback(server: Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected the test server to listen on TCP");
    }
    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function createPeerStub(): Server {
    // Holds the peer port for the whole test so no other process can bind it.
    // Any direct connection is dropped immediately; the client's TLS attempt
    // then fails and the request rejects without ever completing.
    const server = createNetServer((socket) => {
        socket.destroy();
    });
    return server;
}

function restoreEnvVariable(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function captureProxyEnv(): ProxyEnvSnapshot {
    return {
        httpsProxy: process.env.HTTPS_PROXY,
        lowerHttpsProxy: process.env.https_proxy,
        noProxy: process.env.NO_PROXY,
        lowerNoProxy: process.env.no_proxy,
    };
}

function configureProxyEnv(proxyPort: number): void {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
    restoreEnvVariable("HTTPS_PROXY", snapshot.httpsProxy);
    restoreEnvVariable("https_proxy", snapshot.lowerHttpsProxy);
    restoreEnvVariable("NO_PROXY", snapshot.noProxy);
    restoreEnvVariable("no_proxy", snapshot.lowerNoProxy);
}

function createConnectProxy(state: ProxyState): Server {
    const server = createServer();
    server.on("connection", () => {
        state.connections += 1;
    });
    server.on("connect", (request, socket) => {
        state.connectRequests.push({
            method: request.method,
            target: request.url,
        });
        socket.destroy();
    });
    return server;
}

describe("federation client proxy transport", () => {
    it("uses HTTPS_PROXY only when proxy mode is enabled", async () => {
        const proxyState: ProxyState = { connectRequests: [], connections: 0 };
        const proxyServer = createConnectProxy(proxyState);
        const peerStub = createPeerStub();
        const proxyEnv = captureProxyEnv();

        try {
            configureProxyEnv(await listenOnLoopback(proxyServer));
            const peerPort = await listenOnLoopback(peerStub);
            const peer = {
                id: "proxy-runtime-peer",
                baseUrl: `https://127.0.0.1:${peerPort}`,
                outboundToken: "test-token",
            };
            const requestOptions = {
                allowPrivatePeers: true,
                attempts: 1,
                timeoutMs: 500,
            } as const;

            await expect(
                createFederationClient(peer, {
                    ...requestOptions,
                    allowProxy: true,
                }).getManifest(),
            ).rejects.toBeInstanceOf(FederationHttpError);
            expect(proxyState.connectRequests).toEqual([
                {
                    method: "CONNECT",
                    target: `127.0.0.1:${peerPort}`,
                },
            ]);
            expect(proxyState.connections).toBeGreaterThan(0);

            proxyState.connectRequests.length = 0;
            proxyState.connections = 0;
            await expect(
                createFederationClient(peer, requestOptions).getManifest(),
            ).rejects.toBeInstanceOf(FederationHttpError);
            expect(proxyState.connectRequests).toEqual([]);
            expect(proxyState.connections).toBe(0);
        } finally {
            restoreProxyEnv(proxyEnv);
            await closeServer(proxyServer);
            await closeServer(peerStub);
        }
    });
});

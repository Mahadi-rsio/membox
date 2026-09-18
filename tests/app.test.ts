import { describe, expect, it } from "bun:test";
import request from "supertest";
import { createApp } from "../src/index";

const BASE_ENV = {
  UPSTREAM_BASE_URL: "https://api.openai.com/v1",
  CONTEXT_BUDGET: "8000",
};

describe("Express App Endpoints", () => {
  it("responds on GET / with service metadata", async () => {
    const res = await request(createApp(BASE_ENV)).get("/");
    expect(res.status).toBe(200);
    const json = res.body as any;
    expect(json.name).toBe("remember-memory-gateway");
    expect(json.runtime).toBe("Node.js");
    expect(json.database).toContain("Neon");
  });

  it("responds on GET /health", async () => {
    const res = await request(createApp(BASE_ENV)).get("/health");
    expect(res.status).toBe(200);
    const json = res.body as any;
    expect(json.status).toBe("ok");
    expect(json.service).toBe("remember-memory-gateway");
    expect(json.database.provider).toBe("neon");
  });

  it("enforces authentication: missing key returns 401", async () => {
    const res = await request(createApp(BASE_ENV))
      .get("/v1/models")
      .set("Content-Type", "application/json");
    expect(res.status).toBe(401);
  });

  it("rejects invalid API key with 401", async () => {
    const res = await request(createApp(BASE_ENV))
      .get("/v1/models")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(401);
  });

  it("rejects non-Bearer authorization with 401", async () => {
    const res = await request(createApp(BASE_ENV))
      .get("/v1/models")
      .set("Content-Type", "application/json")
      .set("X-API-Key", "1234");
    expect(res.status).toBe(401);
  });
});

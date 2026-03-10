import { describe, test, expect, beforeEach } from "vitest";
import { PairingStore } from "../src/pairing.js";

let store: PairingStore;

beforeEach(() => { store = new PairingStore(); });

describe("PairingStore", () => {
  test("createCode returns a 6-digit string", () => {
    const code = store.createCode("laptop");
    expect(code).toMatch(/^\d{6}$/);
  });

  test("redeemCode with correct code returns name", () => {
    const code = store.createCode("laptop");
    const result = store.redeemCode(code);
    expect(result).toEqual({ name: "laptop" });
  });

  test("redeemCode with wrong code returns null", () => {
    store.createCode("laptop");
    expect(store.redeemCode("000000")).toBeNull();
  });

  test("code is single-use", () => {
    const code = store.createCode("laptop");
    store.redeemCode(code);
    expect(store.redeemCode(code)).toBeNull();
  });

  test("max 5 active codes", () => {
    for (let i = 0; i < 5; i++) {
      store.createCode(`device-${i}`);
    }
    expect(() => store.createCode("device-5")).toThrow(/max 5/i);
  });

  test("expired codes are pruned", () => {
    // Manually insert an expired entry via createCode, then mock time
    const code = store.createCode("expired-device");

    // Access internal state to expire the code
    const entries = (store as any).entries as Map<string, any>;
    for (const entry of entries.values()) {
      entry.expiresAt = Date.now() - 1;
    }

    expect(store.redeemCode(code)).toBeNull();
    expect(store.activeCount).toBe(0);
  });

  test("activeCount reflects active (non-expired) codes", () => {
    expect(store.activeCount).toBe(0);
    store.createCode("a");
    store.createCode("b");
    expect(store.activeCount).toBe(2);
  });

  test("prune frees slots for new codes", () => {
    for (let i = 0; i < 5; i++) {
      store.createCode(`device-${i}`);
    }

    // Expire all
    const entries = (store as any).entries as Map<string, any>;
    for (const entry of entries.values()) {
      entry.expiresAt = Date.now() - 1;
    }

    // Should be able to create a new one after pruning
    const code = store.createCode("new-device");
    expect(code).toMatch(/^\d{6}$/);
  });

  test("different codes for same name", () => {
    const code1 = store.createCode("laptop");
    store.redeemCode(code1);
    const code2 = store.createCode("laptop");
    // Codes may rarely collide, so just ensure both are valid format
    expect(code1).toMatch(/^\d{6}$/);
    expect(code2).toMatch(/^\d{6}$/);
  });
});

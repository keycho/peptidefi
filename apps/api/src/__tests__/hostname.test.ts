import { describe, expect, it } from "vitest";

import { normalizeVendorHostname } from "../lib/hostname";

/**
 * The unique-active-lead constraint in migration 0035 is keyed on
 * the normalized hostname, so this function is the dedup contract.
 * Pin every transformation that affects collision behaviour.
 */

describe("normalizeVendorHostname", () => {
  it("strips scheme + path + query", () => {
    expect(
      normalizeVendorHostname("https://example.com/products/foo?x=1"),
    ).toBe("example.com");
  });

  it("strips a www. prefix", () => {
    expect(normalizeVendorHostname("https://www.example.com")).toBe(
      "example.com",
    );
    expect(normalizeVendorHostname("http://www.purerawz.co/")).toBe(
      "purerawz.co",
    );
  });

  it("preserves non-www subdomains as separate vendors", () => {
    // shop.example and blog.example are different vendor surfaces;
    // the spec intentionally treats them as distinct.
    expect(normalizeVendorHostname("https://shop.example.com")).toBe(
      "shop.example.com",
    );
    expect(normalizeVendorHostname("https://api.purerawz.co")).toBe(
      "api.purerawz.co",
    );
  });

  it("lowercases the host", () => {
    expect(normalizeVendorHostname("HTTPS://EXAMPLE.COM")).toBe("example.com");
    expect(normalizeVendorHostname("https://Example.COM")).toBe("example.com");
  });

  it("tolerates scheme-less input", () => {
    expect(normalizeVendorHostname("example.com")).toBe("example.com");
    expect(normalizeVendorHostname("www.example.com/path")).toBe("example.com");
  });

  it("rejects junk (no TLD, empty, garbage)", () => {
    expect(normalizeVendorHostname("")).toBeNull();
    expect(normalizeVendorHostname("   ")).toBeNull();
    expect(normalizeVendorHostname("localhost")).toBeNull();
    expect(normalizeVendorHostname("not a url")).toBeNull();
  });

  it("DEDUP CONTRACT: equivalent URLs collapse to the same hostname", () => {
    // All but the typo should collapse identically.
    expect(normalizeVendorHostname("https://www.purerawz.co/product/humanin/")).toBe("purerawz.co");
    expect(normalizeVendorHostname("http://purerawz.co/")).toBe("purerawz.co");
    expect(normalizeVendorHostname("purerawz.co")).toBe("purerawz.co");
    expect(normalizeVendorHostname("PURERAWZ.CO")).toBe("purerawz.co");
    // Typo'd hostname (purereawz with extra e) is correctly a different vendor.
    expect(normalizeVendorHostname("https://www.PUREREAWZ.co/?utm=foo")).not.toBe("purerawz.co");
  });
});

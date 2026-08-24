import { describe, expect, test } from "bun:test";
import {
  FULL_DISK_ACCESS_SETTINGS_URLS,
  fullDiskAccessGuidance,
  fullDiskAccessProbePaths,
  hasFullDiskAccess,
  isDarwinPlatform,
  openFullDiskAccessSettings,
} from "../src/setup/macos-fda";

describe("macos-fda", () => {
  test("isDarwinPlatform", () => {
    expect(isDarwinPlatform("darwin")).toBe(true);
    expect(isDarwinPlatform("linux")).toBe(false);
  });

  test("probe paths under home Library", () => {
    const paths = fullDiskAccessProbePaths("/Users/me");
    expect(paths.some((p) => p.includes("Library/Mail"))).toBe(true);
    expect(paths.some((p) => p.includes("Library/Safari"))).toBe(true);
  });

  test("hasFullDiskAccess true when any probe is ok", () => {
    expect(
      hasFullDiskAccess({
        home: "/Users/me",
        probe: (p) => (p.includes("Mail") ? "ok" : "denied"),
      }),
    ).toBe(true);
  });

  test("hasFullDiskAccess false when all denied or missing", () => {
    expect(
      hasFullDiskAccess({
        home: "/Users/me",
        probe: () => "denied",
      }),
    ).toBe(false);
    expect(
      hasFullDiskAccess({
        home: "/Users/me",
        probe: () => "missing",
      }),
    ).toBe(false);
  });

  test("openFullDiskAccessSettings tries URLs", () => {
    const tried: string[] = [];
    const ok = openFullDiskAccessSettings({
      runOpen: (url) => {
        tried.push(url);
        return url === FULL_DISK_ACCESS_SETTINGS_URLS[0];
      },
    });
    expect(ok).toBe(true);
    expect(tried[0]).toBe(FULL_DISK_ACCESS_SETTINGS_URLS[0]);
  });

  test("openFullDiskAccessSettings falls through URLs", () => {
    const tried: string[] = [];
    const ok = openFullDiskAccessSettings({
      runOpen: (url) => {
        tried.push(url);
        return false;
      },
    });
    expect(ok).toBe(false);
    expect(tried.length).toBe(FULL_DISK_ACCESS_SETTINGS_URLS.length);
  });

  test("guidance mentions binary path", () => {
    const g = fullDiskAccessGuidance("/usr/local/bin/acpbot");
    expect(g).toContain("/usr/local/bin/acpbot");
    expect(g).toContain("Full Disk Access");
    expect(g).toContain("acpbot repo add");
  });
});

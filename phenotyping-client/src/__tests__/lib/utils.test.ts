import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn — classname utility", () => {
  it("merges static class names", () => {
    const result = cn("flex items-center gap-2");
    expect(result).toBe("flex items-center gap-2");
  });

  it("handles conditional truthy classes", () => {
    const active = true;
    const result = cn("base-class", active && "conditional-class");
    expect(result).toBe("base-class conditional-class");
  });

  it("omits falsy conditional classes", () => {
    // @ts-expect-error intentional falsy test inputs
    const result = cn("base-class", false && "omit-me", undefined && "omit-me-too");
    expect(result).toBe("base-class");
  });

  it("merges multiple arguments", () => {
    const result = cn("a", "b", "c");
    expect(result).toBe("a b c");
  });

  it("handles undefined and null gracefully", () => {
    const result = cn("a", undefined, null as unknown as string, "b");
    expect(result).toBe("a b");
  });

  it("handles nested arrays", () => {
    const result = cn("a", ["b", "c"], "d");
    expect(result).toBe("a b c d");
  });

  it("handles empty string", () => {
    const result = cn("a", "", "b");
    expect(result).toBe("a b");
  });
});

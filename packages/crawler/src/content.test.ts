import { describe, expect, it } from "vitest";
import { charset, decodeBody, isHtml, mediaType } from "./content.js";

describe("content type helpers", () => {
  it.each([
    ["text/html", true],
    ["text/html; charset=utf-8", true],
    ["TEXT/HTML;charset=UTF-8", true],
    ["application/xhtml+xml", true],
    ["text/plain", false],
    ["application/pdf", false],
    ["image/png", false],
    [null, false],
    ["", false],
  ])("isHtml(%j) → %s", (ct, expected) => {
    expect(isHtml(ct)).toBe(expected);
  });

  it("extracts the media type and charset", () => {
    expect(mediaType("Text/HTML ; charset=ISO-8859-1")).toBe("text/html");
    expect(mediaType(null)).toBeNull();
    expect(charset('text/html; charset="windows-1252"')).toBe("windows-1252");
    expect(charset("text/html")).toBeNull();
  });

  it("decodes with the declared charset, falling back to UTF-8", () => {
    expect(decodeBody(new Uint8Array([0xe9]), "text/html; charset=iso-8859-1")).toBe("é");
    expect(decodeBody(new TextEncoder().encode("é"), "text/html; charset=bogus")).toBe("é");
    expect(decodeBody(new TextEncoder().encode("é"), null)).toBe("é");
  });
});

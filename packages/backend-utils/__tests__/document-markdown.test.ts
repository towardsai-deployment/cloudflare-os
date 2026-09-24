import { describe, expect, it, vi } from "vitest";
import {
  convertDocumentToMarkdown,
  convertibleDocumentFormat,
  DocumentConversionError,
  documentMimeType,
  isExpectedDocumentError,
  unsupportedFileTypeMessage,
} from "../src/document-markdown.js";

const PDF = "application/pdf";
const TEXT = "# report.pdf\n\n## Contents\n\nQuarterly revenue grew by twelve percent across all regions.";

function aiReturning(response: object) {
  let toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
    id: "x", name: doc.name, mimeType: doc.blob.type, ...response,
  }));
  // The Ai type has many members; only toMarkdown is touched.
  return { ai: { toMarkdown } as unknown as Ai, toMarkdown };
}

async function conversionError(promise: Promise<unknown>): Promise<DocumentConversionError> {
  let err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(DocumentConversionError);
  return err as DocumentConversionError;
}

const doc = { name: "report.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: PDF };

describe("convertible document formats", () => {
  it("includes PDF, DOCX and XLSX but not images, PowerPoint or HTML", () => {
    expect(convertibleDocumentFormat(PDF)).toBeDefined();
    expect(convertibleDocumentFormat(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeDefined();
    expect(convertibleDocumentFormat(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBeDefined();
    expect(convertibleDocumentFormat("image/png")).toBeUndefined();
    expect(convertibleDocumentFormat(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBeUndefined();
    expect(convertibleDocumentFormat("text/html")).toBeUndefined();
  });

  it("falls back to the extension when the MIME type is octet-stream or empty", () => {
    expect(documentMimeType("application/octet-stream", "Report.PDF")).toBe(PDF);
    expect(documentMimeType("", "sheet.xlsx"))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(documentMimeType(undefined, "notes.bin")).toBe("application/octet-stream");
    // A specific type wins over the extension, and parameters are stripped.
    expect(documentMimeType("Text/Plain; charset=utf-8", "notes.pdf")).toBe("text/plain");
  });

  it("gives PowerPoint an export-as-PDF hint and names other unsupported types", () => {
    expect(unsupportedFileTypeMessage("", "deck.pptx")).toMatch(/Export it as PDF/);
    expect(unsupportedFileTypeMessage(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toMatch(/Export it as PDF/);
    expect(unsupportedFileTypeMessage("application/zip", "bundle.zip"))
      .toMatch(/^Unsupported file type \(\.zip\)\. Supported documents: PDF/);
  });

  it("doesn't call .key files Keynote, since PEM keys share the extension", () => {
    expect(unsupportedFileTypeMessage("", "server.key")).toMatch(/^Unsupported file type \(\.key\)\./);
    // The browser-reported Keynote type still gets the hint.
    expect(unsupportedFileTypeMessage("application/vnd.apple.keynote", "talk.key")).toMatch(/Export it as PDF/);
  });
});

describe("convertDocumentToMarkdown", () => {
  it("disables image conversion and passes the gateway and its metadata", async () => {
    let { ai, toMarkdown } = aiReturning({ format: "markdown", tokens: 1, data: TEXT });
    let gateway = { id: "gw", metadata: { tool: "chatAttachment" } };

    expect(await convertDocumentToMarkdown(ai, doc, { gateway })).toBe(TEXT);

    let [sent, options] = toMarkdown.mock.calls[0] as unknown as [
      { name: string; blob: Blob }, ConversionRequestOptions];
    expect(sent.name).toBe("report.pdf");
    expect(sent.blob.type).toBe(PDF);
    expect(options.gateway).toEqual(gateway);
    expect(options.conversionOptions?.pdf?.images?.convert).toBe(false);
    expect(options.conversionOptions?.docx?.images?.convert).toBe(false);
  });

  it("reports format='error' as kind 'failed' with the error text", async () => {
    let { ai } = aiReturning({ format: "error", error: "parser blew up" });
    let err = await conversionError(convertDocumentToMarkdown(ai, doc));
    expect(err.kind).toBe("failed");
    expect(err.message).toBe("Couldn't convert report.pdf to text: parser blew up.");
    expect(isExpectedDocumentError(err)).toBe(false);
  });

  it("keeps long or structured service errors out of the message", async () => {
    let long = `Error: upstream 500 {"trace":"abc"}\n    at convert (worker.js:1:1)`;
    let { ai } = aiReturning({ format: "error", error: long });
    let err = await conversionError(convertDocumentToMarkdown(ai, doc));
    expect(err.message).toBe("Couldn't convert report.pdf to text.");

    let thrower = { toMarkdown: vi.fn(async () => { throw new Error("x".repeat(200)); }) } as unknown as Ai;
    err = await conversionError(convertDocumentToMarkdown(thrower, doc));
    expect(err.message).toBe("Couldn't convert report.pdf to text.");
  });

  it("reports a missing binding as kind 'unavailable'", async () => {
    let err = await conversionError(convertDocumentToMarkdown(undefined, doc));
    expect(err.kind).toBe("unavailable");
    expect(err.message).toMatch(/isn't available on this deployment/);
  });

  it("reports near-empty output (headings and metadata only) as kind 'no-text'", async () => {
    let scanned = "# scan.pdf\n\n## Metadata\n- PDFFormatVersion=1.7\n- Producer=Scanner 3000\n\n" +
      "## Contents\n\n### Page 1\n\n![](page1.png)\n\n---\n\n### Page 2\n";
    let { ai } = aiReturning({ format: "markdown", tokens: 1, data: scanned });
    let err = await conversionError(convertDocumentToMarkdown(ai, { ...doc, name: "scan.pdf" }));
    expect(err.kind).toBe("no-text");
    expect(err.message).toMatch(/^No text could be extracted from scan\.pdf\. It may be a scanned or image-only PDF/);
    expect(isExpectedDocumentError(err)).toBe(true);

    // Other formats aren't blamed on scanning.
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    err = await conversionError(convertDocumentToMarkdown(ai, { ...doc, name: "memo.docx", mimeType: docx }));
    expect(err.message).toBe(
      "No text could be extracted from memo.docx. The Word document may be empty or hold only images.");

    // webFetch opts out: a short page is a legitimate result.
    await expect(convertDocumentToMarkdown(ai, doc, { requireText: false })).resolves.toBe(scanned);
  });
});

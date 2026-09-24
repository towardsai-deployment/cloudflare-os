import { describe, expect, it, vi } from "vitest";

// The @validateRpc() transform only runs in the Wrangler build; untransformed it throws, so the
// decorator is an identity here. The generated validator is checked by the build, not this test.
vi.mock("capnweb-validate", () => ({ validateRpc: () => (target: unknown) => target }));

const { ContextApiImpl } = await import("../src/context-api.js");
const { MAX_CONVERTIBLE_UPLOAD_BYTES } = await import("../src/context-types.js");

const TEXT = "# report.pdf\n\n## Contents\n\nQuarterly revenue grew by twelve percent across all regions.";
const PDF_BASE64 = Buffer.from("%PDF-1.7 test").toString("base64");

function aiReturning(data: string) {
  let toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
    id: "x", name: doc.name, mimeType: doc.blob.type, format: "markdown" as const, tokens: 1, data,
  }));
  return { ai: { toMarkdown } as unknown as Ai, toMarkdown };
}

// Fake namespaces: this account owns every collection it asks about, and nothing is public.
function makeApi(ai: Ai | undefined, { owns = true } = {}) {
  let putContextDocument = vi.fn(async () => {});
  let namespace = (stub: object) => ({ idFromName: (name: string) => name, get: () => stub });
  let api = new ContextApiImpl(
    { WORKERS_AI: ai } as unknown as Cloudflare.Env, "workshop.example", "account-1", false,
    namespace({ putContextDocument }) as never,
    namespace({ hasOwned: async () => owns }) as never,
    { getByName: () => ({ isPublic: async () => false }) } as never,
  );
  return { api, putContextDocument };
}

describe("ContextApiImpl.importContextDocument", () => {
  it("stores the converted Markdown as <path>.md and drops the original", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let { api, putContextDocument } = makeApi(ai);

    let result = await api.importContextDocument("c1", "finance/report.pdf", { base64: PDF_BASE64 });

    expect(result).toEqual({ path: "finance/report.pdf.md" });
    expect(putContextDocument).toHaveBeenCalledTimes(1);
    expect(putContextDocument).toHaveBeenCalledWith("finance/report.pdf.md", {
      description: "Converted from report.pdf",
      body: TEXT,
      contentType: "text/markdown",
    });
    let [sent, options] = toMarkdown.mock.calls[0] as unknown as [
      { name: string; blob: Blob }, ConversionRequestOptions];
    expect(sent.blob.type).toBe("application/pdf");
    expect(new TextDecoder().decode(await sent.blob.arrayBuffer())).toBe("%PDF-1.7 test");
    expect(options.conversionOptions?.pdf?.images?.convert).toBe(false);
  });

  it("keeps an author-supplied description", async () => {
    let { ai } = aiReturning(TEXT);
    let { api, putContextDocument } = makeApi(ai);

    await api.importContextDocument("c1", "report.pdf", { base64: PDF_BASE64, description: "Q3 numbers" });

    expect(putContextDocument.mock.calls[0]).toMatchObject(["report.pdf.md", { description: "Q3 numbers" }]);
  });

  it("rejects an upload over the raw cap before converting", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let { api, putContextDocument } = makeApi(ai);
    let base64 = "A".repeat(Math.ceil((MAX_CONVERTIBLE_UPLOAD_BYTES + 2 * 1024 * 1024) * 4 / 3));

    await expect(api.importContextDocument("c1", "big.pdf", { base64 }))
      .rejects.toThrow("big.pdf is 12 MB; documents must be 10 MB or smaller.");
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(putContextDocument).not.toHaveBeenCalled();
  });

  it("rejects PowerPoint with an export-as-PDF hint", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let { api } = makeApi(ai);

    await expect(api.importContextDocument("c1", "deck.pptx", { base64: PDF_BASE64 }))
      .rejects.toThrow("PowerPoint files (.pptx) can't be converted. Export it as PDF and upload that.");
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("reports a missing Workers AI binding", async () => {
    let { api, putContextDocument } = makeApi(undefined);

    await expect(api.importContextDocument("c1", "report.pdf", { base64: PDF_BASE64 }))
      .rejects.toThrow("Document conversion isn't available on this deployment (Workers AI isn't bound).");
    expect(putContextDocument).not.toHaveBeenCalled();
  });

  it("rejects a scanned PDF with no extractable text", async () => {
    let { ai } = aiReturning("# scan.pdf\n\n## Metadata\n- Producer=Scanner\n\n## Contents\n\n### Page 1\n");
    let { api, putContextDocument } = makeApi(ai);

    await expect(api.importContextDocument("c1", "scan.pdf", { base64: PDF_BASE64 }))
      .rejects.toThrow(/^No text could be extracted from scan\.pdf\. It may be a scanned or image-only PDF/);
    expect(putContextDocument).not.toHaveBeenCalled();
  });

  it("rejects converted text over the stored-size cap", async () => {
    let { ai } = aiReturning("x".repeat(1_000_000));
    let { api } = makeApi(ai);

    await expect(api.importContextDocument("c1", "report.pdf", { base64: PDF_BASE64 }))
      .rejects.toThrow("report.pdf converts to 977 KB of text; the limit is 879 KB. Split it or upload only the pages you need.");
  });

  it("checks write access before converting", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let { api } = makeApi(ai, { owns: false });

    await expect(api.importContextDocument("c1", "report.pdf", { base64: PDF_BASE64 }))
      .rejects.toThrow("Collection not found or you don't have access.");
    expect(toMarkdown).not.toHaveBeenCalled();
  });
});

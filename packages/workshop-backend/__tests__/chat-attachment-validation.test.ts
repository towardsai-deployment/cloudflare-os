import { describe, expect, it, vi } from "vitest";
import {
  assertChatAttachmentSupportedByProvider,
  chatAttachmentNeedsConversion,
  convertChatAttachmentToMarkdown,
  isAllowedChatAttachmentImageMimeType,
  MAX_CONVERTIBLE_CHAT_ATTACHMENT_BYTES,
  validateChatAttachmentUpload,
} from "../src/chat-attachment-validation.js";

describe("assertChatAttachmentSupportedByProvider", () => {
  it("allows text and supported images without a selected model", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "text/plain", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "image/png", 1)).not.toThrow();
  });

  it("rejects pdfs without a selected model", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "application/pdf", 1))
      .toThrow("Unsupported file type");
  });

  it("applies provider raw-file policy", () => {
    // Text + images are universal; PDFs are additionally bridged to providers whose APIs take
    // documents (see chat-attachment-pdf.ts), which Workers AI and Ollama do not.
    expect(() => assertChatAttachmentSupportedByProvider("anthropic", "text/plain", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("anthropic", "application/pdf", 1))
      .not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("openai", "image/jpeg", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("openai", "application/pdf", 1))
      .not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("google", "application/pdf", 1))
      .not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("google", "application/zip", 1))
      .toThrow("Unsupported file type");
    // Still true of the validator itself: uploads for such providers are converted to Markdown
    // before validation (see chatAttachmentNeedsConversion), so a raw PDF never reaches it.
    expect(() => assertChatAttachmentSupportedByProvider("cloudflare", "application/pdf", 1))
      .toThrow("Unsupported file type");
    expect(() => assertChatAttachmentSupportedByProvider("ollama", "application/zip", 1))
      .toThrow("Unsupported file type");
  });

  it("enforces the per-file byte limit", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "text/plain", 1024 * 1024 + 1))
      .toThrow("Chat attachment is too large.");
  });

  it("tells PowerPoint uploads to export as PDF", () => {
    expect(() => assertChatAttachmentSupportedByProvider(
      "cloudflare", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1,
      "deck.pptx")).toThrow("PowerPoint files (.pptx) can't be converted. Export it as PDF and upload that.");
  });
});

describe("chatAttachmentNeedsConversion", () => {
  it("converts documents for providers without native document input", () => {
    for (const provider of ["cloudflare", "gateway-openai", "ollama", undefined] as const) {
      expect(chatAttachmentNeedsConversion(provider, "application/pdf", "report.pdf")).toBe(true);
    }
    // Office formats are converted even for PDF-capable providers.
    expect(chatAttachmentNeedsConversion("anthropic",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "memo.docx")).toBe(true);
    // An empty or generic MIME type falls back to the extension.
    expect(chatAttachmentNeedsConversion("cloudflare", "", "report.pdf")).toBe(true);
  });

  it("keeps native PDF input for providers that have it", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      expect(chatAttachmentNeedsConversion(provider, "application/pdf", "report.pdf")).toBe(false);
    }
  });

  it("leaves text and images alone", () => {
    expect(chatAttachmentNeedsConversion("cloudflare", "text/plain", "notes.txt")).toBe(false);
    expect(chatAttachmentNeedsConversion("cloudflare", "text/html", "page.html")).toBe(false);
    expect(chatAttachmentNeedsConversion("gateway-openai", "image/png", "photo.png")).toBe(false);
  });
});

describe("convertChatAttachmentToMarkdown", () => {
  const pdf = { mimeType: "application/pdf", content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), name: "report.pdf" };

  function aiReturning(data: string) {
    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x", name: doc.name, mimeType: doc.blob.type, format: "markdown" as const, tokens: 1, data,
    }));
    return { ai: { toMarkdown } as unknown as Ai, toMarkdown };
  }

  it("stores the Markdown as <name>.md, which then validates for text-only providers", async () => {
    const text = "# report.pdf\n\nRevenue grew twelve percent in the third quarter of the year.";
    const { ai, toMarkdown } = aiReturning(text);
    const gateway = { id: "gw", metadata: { tool: "chatAttachment" } };

    const converted = await convertChatAttachmentToMarkdown(ai, gateway, pdf);

    expect(converted.mimeType).toBe("text/markdown");
    expect(converted.name).toBe("report.pdf.md");
    expect(new TextDecoder().decode(converted.content)).toBe(text);
    expect(toMarkdown.mock.calls[0][1]).toMatchObject({ gateway });
    expect(() => validateChatAttachmentUpload(converted, "gateway-openai")).not.toThrow();
  });

  it("rejects documents over the raw cap before converting", async () => {
    const { ai, toMarkdown } = aiReturning("unused");
    const big = { ...pdf, content: new Uint8Array(MAX_CONVERTIBLE_CHAT_ATTACHMENT_BYTES + 1200 * 1024) };

    await expect(convertChatAttachmentToMarkdown(ai, undefined, big))
      .rejects.toThrow("report.pdf is 11.2 MB; documents must be 10 MB or smaller.");
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("rejects converted text over the 256 KB chat cap", async () => {
    const { ai } = aiReturning("x".repeat(300 * 1024));

    await expect(convertChatAttachmentToMarkdown(ai, undefined, pdf)).rejects.toThrow(
      "report.pdf converts to 300 KB of text; the limit is 256 KB. Split it or upload only the pages you need.");
  });

  it("surfaces the converter's message when nothing is bound", async () => {
    await expect(convertChatAttachmentToMarkdown(undefined, undefined, pdf))
      .rejects.toThrow("Document conversion isn't available on this deployment");
  });
});

describe("validateChatAttachmentUpload", () => {
  it("normalizes MIME parameters before validation", () => {
    let attachment = validateChatAttachmentUpload({
      mimeType: "text/plain; charset=utf-8",
      content: new Uint8Array([1]),
      name: "notes.txt",
    });

    expect(attachment.mimeType).toBe("text/plain");
  });

  it.each([
    { label: "missing MIME type", mimeType: "", name: undefined },
    { label: "MIME type with a newline", mimeType: "text/plain\r\ninvalid", name: "notes.txt" },
    { label: "empty normalized MIME type", mimeType: ";", name: " \r\n " },
  ])("normalizes $label to octet-stream", ({ mimeType, name }) => {
    let attachment = { mimeType, content: new Uint8Array([1]), name };

    // Normalization happens before the support check, so the rejection is for the normalized
    // type (octet-stream, which no provider accepts), left visible on the mutated upload.
    expect(() => validateChatAttachmentUpload(attachment, "google"))
      .toThrow("Unsupported file type");
    expect(attachment.mimeType).toBe("application/octet-stream");
  });

  it("accepts matching JPEG content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0xff, 0xd8, 0xff]),
      name: "photo.jpg",
    })).not.toThrow();
  });

  it("accepts matching PNG and WebP content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.png",
    })).not.toThrow();

    expect(() => validateChatAttachmentUpload({
      mimeType: "image/webp",
      content: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      name: "photo.webp",
    })).not.toThrow();
  });

  it("rejects image bytes that do not match their MIME", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.jpg",
    })).toThrow("Chat attachment content does not match its MIME type.");
  });

  it("checks the PDF signature for PDF-capable providers", () => {
    // "%PDF-"
    expect(() => validateChatAttachmentUpload({
      mimeType: "application/pdf",
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      name: "report.pdf",
    }, "anthropic")).not.toThrow();

    expect(() => validateChatAttachmentUpload({
      mimeType: "application/pdf",
      content: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
      name: "report.pdf",
    }, "anthropic")).toThrow("Chat attachment content does not match its MIME type.");
  });

  it("rejects WebP headers with a mismatch at every checked byte", () => {
    const validWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) {
      const invalidWebp = validWebp.slice();
      invalidWebp[index] ^= 0xff;

      expect(() => validateChatAttachmentUpload({
        mimeType: "image/webp",
        content: invalidWebp,
        name: "photo.webp",
      })).toThrow("Chat attachment content does not match its MIME type.");
    }
  });

  it("identifies supported image MIME types", () => {
    expect(isAllowedChatAttachmentImageMimeType("image/png; charset=utf-8")).toBe(true);
    expect(isAllowedChatAttachmentImageMimeType(undefined)).toBe(false);
  });
});

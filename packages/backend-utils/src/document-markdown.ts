// Document-to-Markdown conversion through the Workers AI binding's `toMarkdown()`, shared by the
// Workshop (webFetch, chat attachments) and the Context Library. Conversion stays in the free tier:
// embedded images in PDFs and Word documents are never sent to the paid image models, so a scanned
// PDF yields no text and is rejected with a message rather than OCRed.

export * from "./document-formats.js";

/** Why a document could not be converted; `message` is written for the person who uploaded it. */
export type DocumentConversionErrorKind =
  /** No Workers AI binding on this deployment. */
  | "unavailable"
  /** `toMarkdown()` threw or returned `format: "error"`. */
  | "failed"
  /** The conversion succeeded but produced (next to) no text, e.g. a scanned PDF. */
  | "no-text";

/** A conversion failure with a user-readable message. */
export class DocumentConversionError extends Error {
  constructor(readonly kind: DocumentConversionErrorKind, message: string) {
    super(message);
    this.name = "DocumentConversionError";
  }
}

/** The document handed to {@link convertDocumentToMarkdown}. */
export interface DocumentToConvert {
  /** File name; `toMarkdown()` uses it as a format hint, and messages quote it. */
  name: string;
  bytes: Uint8Array;
  /** Normalized MIME type (see `documentMimeType`). */
  mimeType: string;
}

/** Options for {@link convertDocumentToMarkdown}. */
export interface DocumentConversionOptions {
  /** AI Gateway to log the call through. Binding calls only reach same-account gateways. */
  gateway?: GatewayOptions;
  /** Extra format options, e.g. webFetch's HTML hostname. Image conversion is always forced off. */
  conversionOptions?: ConversionOptions;
  /**
   * Reject output with (next to) no text as `no-text`. Defaults to true; webFetch turns it off,
   * since a short page is a legitimate result there.
   */
  requireText?: boolean;
}

// Calibration candidate from the implementation plan, NOT yet calibrated: fewer non-whitespace
// characters than this, after stripping headings, the metadata block, image syntax and rules,
// counts as "no text". Needs calibration on live toMarkdown output from one text PDF and one
// image-only PDF (live acceptance step A7) before it is relied on.
const MIN_EXTRACTED_TEXT_CHARS = 32;

/**
 * Convert one document to Markdown. Throws {@link DocumentConversionError} when there is no
 * binding, when the conversion fails, or (unless `requireText` is false) when it yields no text.
 */
export async function convertDocumentToMarkdown(
  ai: Ai | undefined,
  document: DocumentToConvert,
  options: DocumentConversionOptions = {},
): Promise<string> {
  if (!ai) {
    throw new DocumentConversionError(
      "unavailable", "Document conversion isn't available on this deployment (Workers AI isn't bound).");
  }

  let result: ConversionResponse;
  try {
    result = await ai.toMarkdown(
      { name: document.name, blob: new Blob([document.bytes], { type: document.mimeType }) },
      {
        gateway: options.gateway,
        conversionOptions: {
          ...options.conversionOptions,
          // Embedded-image conversion runs paid Workers AI models (and would be the only OCR path
          // for scanned pages), so it is never requested.
          pdf: { ...options.conversionOptions?.pdf, images: { convert: false } },
          docx: { ...options.conversionOptions?.docx, images: { convert: false } },
        },
      },
    );
  } catch (err) {
    throw new DocumentConversionError(
      "failed", `Couldn't convert ${document.name} to text: ${err instanceof Error ? err.message : String(err)}.`);
  }

  if (result.format === "error") {
    throw new DocumentConversionError("failed", `Couldn't convert ${document.name} to text: ${result.error}.`);
  }
  if ((options.requireText ?? true) && extractedTextLength(result.data) < MIN_EXTRACTED_TEXT_CHARS) {
    throw new DocumentConversionError(
      "no-text",
      `No text could be extracted from ${document.name}. It may be a scanned or image-only PDF; ` +
        "run OCR on it first.");
  }
  return result.data;
}

/**
 * Non-whitespace characters of body text in `toMarkdown()` output: headings (the file name and
 * per-page titles), the metadata section, YAML frontmatter, image syntax and horizontal rules are
 * not counted, since a scanned PDF still produces all of them.
 */
export function extractedTextLength(markdown: string): number {
  let lines = markdown.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    let end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  let inMetadata = false;
  let count = 0;
  for (let line of lines.slice(start)) {
    let heading = /^\s{0,3}#{1,6}\s*(.*)$/.exec(line);
    if (heading) {
      inMetadata = /^metadata\b/i.test(heading[1].trim());
      continue;
    }
    if (inMetadata || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    count += line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, "").length;
  }
  return count;
}

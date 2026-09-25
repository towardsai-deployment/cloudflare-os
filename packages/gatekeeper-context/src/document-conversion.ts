// Document-to-Markdown conversion for the Context Library: converting an upload before it is
// stored (ContextApi.importContextDocument), and converting a stored PDF or Office document when
// an agent reads it (LibraryReadSession.read), so agents get text rather than a base64 data: URI.

import { Buffer } from "node:buffer";
import {
  convertDocumentToMarkdown, convertibleDocumentFormat, DocumentConversionError, documentMimeType,
  fileExtension,
  formatByteSize, unsupportedFileTypeMessage,
} from "@gadgets/backend-utils/document-markdown";
import {
  MAX_CONVERTED_MARKDOWN_CHARS, MAX_CONVERTIBLE_UPLOAD_BYTES, MAX_DOCUMENT_BODY_BYTES, VENDOR_ID,
  type ContextDocument,
} from "./context-types.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({ component: "gatekeeper.context", vendorId: VENDOR_ID });

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The decoded size of a base64 string, exactly, so it agrees with the browser's `File.size`. */
export function base64DecodedLength(base64: string): number {
  let padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

// Which stored-text cap converted Markdown exceeds, if any. UTF-8 bytes are never fewer than UTF-16
// code units, so the character cap binds for mostly Latin text and the byte cap for the rest.
function overConvertedTextLimit(markdown: string, utf8Bytes: number): string | undefined {
  if (markdown.length > MAX_CONVERTED_MARKDOWN_CHARS) {
    return `${MAX_CONVERTED_MARKDOWN_CHARS.toLocaleString("en-US")} characters`;
  }
  if (utf8Bytes > MAX_DOCUMENT_BODY_BYTES) return formatByteSize(MAX_DOCUMENT_BODY_BYTES);
  return undefined;
}

// The longest prefix of `markdown` within both stored-text caps, cut on a character boundary.
function truncateConvertedText(markdown: string): string {
  let cut = markdown.slice(0, MAX_CONVERTED_MARKDOWN_CHARS);
  let last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);  // don't split a surrogate pair
  // encodeInto stops before the first character that doesn't fit, and reports code units read.
  let { read } = new TextEncoder().encodeInto(cut, new Uint8Array(MAX_DOCUMENT_BODY_BYTES));
  return cut.slice(0, read);
}

/**
 * Convert an uploaded document (base64) to the Markdown stored in its place at `<path>.md`.
 * Throws a user-readable error for an unsupported type, an oversized upload or result, a missing
 * binding, a failed conversion, or a document with no extractable text.
 */
export async function convertUploadedDocument(
  ai: Ai | undefined,
  path: string,
  base64: string,
): Promise<{ path: string; markdown: string }> {
  let name = fileName(path);
  let mimeType = documentMimeType(undefined, name);
  if (!convertibleDocumentFormat(mimeType)) {
    throw new DocumentConversionError("unsupported", unsupportedFileTypeMessage(undefined, name));
  }

  // Reject before decoding.
  let rawBytes = base64DecodedLength(base64);
  if (rawBytes > MAX_CONVERTIBLE_UPLOAD_BYTES) {
    throw new DocumentConversionError("too-large",
      `${name} is ${formatByteSize(rawBytes)}; documents must be ` +
      `${formatByteSize(MAX_CONVERTIBLE_UPLOAD_BYTES)} or smaller.`);
  }
  let bytes = new Uint8Array(Buffer.from(base64, "base64"));
  let markdown = await convertDocumentToMarkdown(ai, { name, bytes, mimeType });

  let utf8Bytes = new TextEncoder().encode(markdown).byteLength;
  let limit = overConvertedTextLimit(markdown, utf8Bytes);
  if (limit) {
    let size = limit.endsWith("characters")
      ? `${markdown.length.toLocaleString("en-US")} characters`
      : formatByteSize(utf8Bytes);
    throw new DocumentConversionError("too-large",
      `${name} converts to ${size} of text; the limit is ${limit}. Split it or upload only the pages you need.`);
  }
  return { path: `${path}.md`, markdown };
}

/**
 * The content an agent's read() returns for a stored binary document. A convertible document
 * (a PDF uploaded before conversion existed, or one synced from Git) is converted to Markdown
 * under a one-line provenance note, or replaced by a short note when that fails: either beats
 * megabytes of base64 the model can't use. Images and other binaries stay data: URIs. The text
 * is held to the same caps as an upload's, and cut with a note past them.
 */
export async function readBinaryDocumentContent(ai: Ai | undefined, doc: ContextDocument): Promise<string> {
  let mimeType = documentMimeType(doc.contentType, doc.name);
  if (!convertibleDocumentFormat(mimeType)) return `data:${doc.contentType};base64,${doc.body}`;

  let label = fileExtension(doc.name).toUpperCase() || mimeType;
  try {
    // TODO: cache the converted text per (path, lastUpdated). Each read converts again, which is
    // free but costs a toMarkdown() round trip every time.
    let markdown = await convertDocumentToMarkdown(ai, {
      name: doc.name, bytes: new Uint8Array(Buffer.from(doc.body, "base64")), mimeType,
    });
    let header = `> Converted from the stored ${label} file ${doc.name} for reading.`;
    let limit = overConvertedTextLimit(markdown, new TextEncoder().encode(markdown).byteLength);
    if (limit) {
      markdown = truncateConvertedText(markdown);
      header += `\n> Truncated: its text is longer than the ${limit} one read returns; this is the start. ` +
        "Split the file and upload the parts to read the rest.";
    }
    return `${header}\n\n${markdown}`;
  } catch (err) {
    // A deployment without the binding is configuration, not a failure worth a log per read.
    if (!(err instanceof DocumentConversionError && err.kind === "unavailable")) {
      logger.warn("failed to convert stored document on read", {
        event: "document.read.convert.failed", error: err,
      });
    }
    // Only conversion errors carry messages written for the reader.
    let reason = err instanceof DocumentConversionError ? err.message : "The conversion failed.";
    return `[${doc.name} is a stored ${label} file that couldn't be shown as text. ${reason}]`;
  }
}

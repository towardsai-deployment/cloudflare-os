// Document formats that Workers AI's `toMarkdown()` converts for free, and the messages shown when
// an upload is not one of them. Pure data with no Workers types, so browser bundles (the Context
// Library app) can share it with the Workers that do the conversion (see ./document-markdown.ts).

/** A binary document format converted to Markdown at upload. */
export interface ConvertibleDocumentFormat {
  /** Canonical MIME type, as sent to `toMarkdown()`. */
  mimeType: string;
  /** Lowercased file extensions, without the dot. */
  extensions: readonly string[];
  /** Short human-readable name for messages. */
  label: string;
}

/**
 * Binary document formats that `toMarkdown()` converts without Workers AI model usage, from
 * https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/.
 * Images are excluded because their conversion runs paid models; HTML, XML and CSV are excluded
 * because they are already text and are stored as such.
 */
export const CONVERTIBLE_DOCUMENTS: readonly ConvertibleDocumentFormat[] = [
  { mimeType: "application/pdf", extensions: ["pdf"], label: "PDF" },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    label: "Word document",
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
    label: "Excel workbook",
  },
  { mimeType: "application/vnd.ms-excel", extensions: ["xls"], label: "Excel workbook" },
  { mimeType: "application/vnd.ms-excel.sheet.macroenabled.12", extensions: ["xlsm"], label: "Excel workbook" },
  { mimeType: "application/vnd.ms-excel.sheet.binary.macroenabled.12", extensions: ["xlsb"], label: "Excel workbook" },
  { mimeType: "application/vnd.oasis.opendocument.spreadsheet", extensions: ["ods"], label: "OpenDocument spreadsheet" },
  { mimeType: "application/vnd.oasis.opendocument.text", extensions: ["odt"], label: "OpenDocument text" },
  { mimeType: "application/vnd.apple.numbers", extensions: ["numbers"], label: "Numbers spreadsheet" },
];

/** Formats listed in the unsupported-type message. */
const SUPPORTED_DOCUMENTS_SUMMARY =
  "PDF, Word (.docx), Excel (.xlsx, .xls), OpenDocument (.odt, .ods) and Numbers";

const BY_MIME_TYPE = new Map(CONVERTIBLE_DOCUMENTS.map(format => [format.mimeType, format]));
const BY_EXTENSION = new Map(
  CONVERTIBLE_DOCUMENTS.flatMap(format => format.extensions.map(ext => [ext, format] as const)));

/**
 * Binary formats that look like documents but that `toMarkdown()` cannot convert, keyed by
 * extension, each with the message to show instead of a generic rejection.
 */
export const UNSUPPORTED_DOCUMENT_HINTS: ReadonlyMap<string, string> = new Map([
  ["pptx", "PowerPoint files (.pptx) can't be converted. Export it as PDF and upload that."],
  ["ppt", "PowerPoint files (.ppt) can't be converted. Export it as PDF and upload that."],
  ["pps", "PowerPoint files (.pps) can't be converted. Export it as PDF and upload that."],
  ["ppsx", "PowerPoint files (.ppsx) can't be converted. Export it as PDF and upload that."],
  ["odp", "OpenDocument presentations (.odp) can't be converted. Export it as PDF and upload that."],
  ["key", "Keynote files (.key) can't be converted. Export it as PDF and upload that."],
  ["doc", "Legacy Word files (.doc) can't be converted. Save it as .docx or PDF and upload that."],
  ["pages", "Pages files (.pages) can't be converted. Export it as PDF and upload that."],
]);

const PRESENTATION_MIME_EXTENSIONS = new Map([
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/vnd.apple.keynote", "key"],
  ["application/msword", "doc"],
  ["application/vnd.apple.pages", "pages"],
]);

/** The lowercased extension of a file name or path, without the dot, or "" when it has none. */
export function fileExtension(name: string | undefined): string {
  if (!name) return "";
  let base = name.slice(name.lastIndexOf("/") + 1);
  let dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Normalize a MIME type (parameters stripped, lowercased) and, when it is missing or the generic
 * `application/octet-stream` that browsers report for unknown types, derive it from the file
 * extension of a convertible document. Returns "application/octet-stream" when neither helps.
 */
export function documentMimeType(mimeType: string | undefined, name: string | undefined): string {
  let normalized = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return BY_EXTENSION.get(fileExtension(name))?.mimeType ?? "application/octet-stream";
}

/** The convertible format for a normalized MIME type (see {@link documentMimeType}), if any. */
export function convertibleDocumentFormat(mimeType: string): ConvertibleDocumentFormat | undefined {
  return BY_MIME_TYPE.get(mimeType);
}

/** Whether a file name or path has the extension of a convertible document. */
export function isConvertibleDocumentName(name: string | undefined): boolean {
  return BY_EXTENSION.has(fileExtension(name));
}

/**
 * The message for an upload that is neither convertible nor otherwise accepted: a specific hint
 * for presentation and legacy formats (e.g. "export it as PDF"), else a generic rejection that
 * names the type and lists the convertible documents.
 */
export function unsupportedFileTypeMessage(mimeType: string | undefined, name?: string): string {
  let ext = fileExtension(name);
  let normalized = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  let hint = UNSUPPORTED_DOCUMENT_HINTS.get(ext) ??
    UNSUPPORTED_DOCUMENT_HINTS.get(PRESENTATION_MIME_EXTENSIONS.get(normalized) ?? "");
  if (hint) return hint;
  let described = ext ? `.${ext}` : normalized || "unknown";
  return `Unsupported file type (${described}). Supported documents: ${SUPPORTED_DOCUMENTS_SUMMARY}.`;
}

/** Format a byte count for messages, in binary units ("256 KB", "16.2 MB"). */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

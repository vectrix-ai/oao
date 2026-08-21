import { unzipSync } from "fflate";
import { SaxesParser } from "saxes";

const MAX_OPEN_DOCUMENT_XML_BYTES = 20 * 1024 * 1024;
const MAX_OPEN_DOCUMENT_ENTRIES = 2_000;

function contentXml(bytes: Uint8Array): Uint8Array {
  const isZip =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
  if (!isZip) return bytes;

  let entries = 0;
  const extracted = unzipSync(bytes, {
    filter: (entry) => {
      entries += 1;
      if (entries > MAX_OPEN_DOCUMENT_ENTRIES)
        throw new Error("OpenDocument archive contains too many entries");
      if (entry.originalSize > MAX_OPEN_DOCUMENT_XML_BYTES)
        throw new Error("OpenDocument XML exceeds the extraction limit");
      return entry.name === "content.xml";
    },
  });
  const content = extracted["content.xml"];
  if (!content) throw new Error("OpenDocument content.xml is missing");
  return content;
}

/** Extracts model-visible text from zipped and flat OpenDocument variants. */
export function extractOpenDocumentText(bytes: Uint8Array): string {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(
    contentXml(bytes),
  );
  const chunks: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("text", (text) => chunks.push(text));
  parser.on("cdata", (text) => chunks.push(text));
  parser.on("opentag", (tag) => {
    if (tag.local === "tab") chunks.push("\t");
    if (tag.local === "line-break") chunks.push("\n");
    if (tag.local === "s") {
      const countAttribute = Object.values(tag.attributes).find(
        (attribute) => attribute.local === "c",
      );
      const count = Number.parseInt(countAttribute?.value ?? "1", 10);
      chunks.push(
        " ".repeat(Number.isFinite(count) ? Math.min(count, 100) : 1),
      );
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.local === "table-cell") chunks.push("\t");
    if (tag.local === "p" || tag.local === "h" || tag.local === "table-row")
      chunks.push("\n");
    if (tag.local === "page") chunks.push("\n\n");
  });
  parser.write(xml).close();

  return chunks
    .join("")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n[\t ]+/gu, "\n")
    .replace(/[\t ]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

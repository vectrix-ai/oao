import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractOpenDocumentText } from "../../src/open-document.js";

const presentationXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:presentation>
    <draw:page><text:h>Renewal summary</text:h><text:p>Northwind value is EUR 48000.</text:p></draw:page>
  </office:presentation></office:body>
</office:document-content>`;

test("extracts text from a zipped OpenDocument presentation", () => {
  const bytes = zipSync({ "content.xml": strToU8(presentationXml) });
  assert.equal(
    extractOpenDocumentText(bytes),
    "Renewal summary\nNorthwind value is EUR 48000.",
  );
});

test("extracts text from a flat OpenDocument document", () => {
  assert.equal(
    extractOpenDocumentText(strToU8(presentationXml)),
    "Renewal summary\nNorthwind value is EUR 48000.",
  );
});

test("rejects a zipped document without content.xml", () => {
  assert.throws(
    () => extractOpenDocumentText(zipSync({ "other.xml": strToU8("<x/>") })),
    /content\.xml is missing/u,
  );
});

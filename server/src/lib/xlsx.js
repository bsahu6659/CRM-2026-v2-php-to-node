/**
 * Minimal XLSX writer.
 *
 * An .xlsx file is a ZIP of XML parts, assembled here by hand. A spreadsheet
 * library would do this for us, but every maintained one pulls a dependency
 * tree of its own, and this writer is ~200 lines against Node's built-in zlib.
 *
 * Cells are written as inline strings rather than shared strings. That costs a
 * little file size and buys two things: no second pass to build a string table
 * (so a large export streams straight out), and immunity to CSV-style formula
 * injection — Excel only evaluates a formula from an <f> element, so a value
 * of "=cmd|..." in an inlineStr cell stays inert text.
 */

import zlib from 'node:zlib';

export function colLetter(index) {
  let letters = '';
  let n = index;
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}

export function xlsxEscape(value) {
  // Strip the control characters Excel refuses to open a file over, then
  // XML-escape what is left.
  const clean = String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Excel stores dates as days since 1899-12-30. Returning null tells the caller
 * to write the original text instead, which is more honest than an obviously
 * wrong 1900 date when a value failed to parse.
 */
export function dateSerial(value) {
  if (!value) return null;
  // 'YYYY-MM-DD HH:MM:SS' is not an ISO string; make it one so the parse is
  // not left to the engine's discretion.
  const normalized = typeof value === 'string' ? value.trim().replace(' ', 'T') : value;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  // Convert to a local-clock serial: Excel has no concept of a time zone, and
  // the dates the API emits are already local.
  const localMs = d.getTime() - d.getTimezoneOffset() * 60_000;
  return 25569 + localMs / 86_400_000;
}

function cell(rowNum, colIndex, value, type) {
  const ref = colLetter(colIndex) + rowNum;
  if (value === null || value === undefined || value === '') return '';

  if (type === 'number') {
    if (value === true || value === false || Number.isNaN(Number(value))) {
      return `<c r="${ref}" t="inlineStr"><is><t>${xlsxEscape(value)}</t></is></c>`;
    }
    return `<c r="${ref}"><v>${Number(value)}</v></c>`;
  }

  if (type === 'date' || type === 'datetime') {
    const serial = dateSerial(value);
    if (serial !== null) {
      const style = type === 'date' ? 2 : 3;
      return `<c r="${ref}" s="${style}"><v>${Math.round(serial * 1e6) / 1e6}</v></c>`;
    }
  }

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xlsxEscape(value)}</t></is></c>`;
}

/**
 * @param {Array<{key:string,label:string,type?:string,width?:number}>} columns
 * @param {Iterable<object>} rows  records keyed by column key
 */
export function sheetXml(columns, rows) {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

  let cols = '';
  columns.forEach((col, i) => {
    const width = col.width ?? Math.max(12, Math.min(40, String(col.label).length + 6));
    cols += `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  });
  if (cols !== '') xml += `<cols>${cols}</cols>`;

  xml += '<sheetData><row r="1">';
  columns.forEach((col, i) => {
    xml += `<c r="${colLetter(i)}1" t="inlineStr" s="1"><is><t>${xlsxEscape(col.label)}</t></is></c>`;
  });
  xml += '</row>';

  let rowNum = 1;
  for (const row of rows) {
    rowNum++;
    xml += `<row r="${rowNum}">`;
    columns.forEach((col, i) => {
      xml += cell(rowNum, i, row?.[col.key] ?? null, col.type ?? 'string');
    });
    xml += '</row>';
  }
  xml += '</sheetData>';
  // Every real export gets sorted and filtered the moment it is opened.
  xml += `<autoFilter ref="A1:${colLetter(columns.length - 1)}${rowNum}"/>`;
  xml += '</worksheet>';
  return xml;
}

// ---------------------------------------------------------------------------
// ZIP container (raw deflate, no archiver dependency)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pack(spec, values) {
  // spec: 'v' = uint16 LE, 'V' = uint32 LE — the subset the ZIP headers need.
  const size = [...spec].reduce((n, c) => n + (c === 'v' ? 2 : 4), 0);
  const buf = Buffer.alloc(size);
  let offset = 0;
  [...spec].forEach((c, i) => {
    if (c === 'v') {
      buf.writeUInt16LE(values[i] & 0xffff, offset);
      offset += 2;
    } else {
      buf.writeUInt32LE(values[i] >>> 0, offset);
      offset += 4;
    }
  });
  return buf;
}

export function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // A fixed timestamp keeps repeated exports of the same data byte-identical,
  // which is what makes the export test assertable.
  const dosTime = 0;
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const uncompressed = data.length;

    let payload = zlib.deflateRawSync(data, { level: 6 });
    let method = 8;
    if (payload.length >= uncompressed) {
      payload = data;
      method = 0;
    }
    const compressed = payload.length;

    const header = pack('vvvvvVVVvv', [
      20, 0, method, dosTime, dosDate, crc, compressed, uncompressed, nameBuf.length, 0,
    ]);

    localParts.push(Buffer.from('PK\x03\x04', 'binary'), header, nameBuf, payload);
    centralParts.push(
      Buffer.from('PK\x01\x02', 'binary'),
      pack('v', [20]),
      header,
      // comment len, disk no, internal attrs, external attrs, local header offset
      pack('vvvVV', [0, 0, 0, 32, offset]),
      nameBuf
    );
    offset += 4 + header.length + nameBuf.length + compressed;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const count = Object.keys(files).length;
  const end = Buffer.concat([
    Buffer.from('PK\x05\x06', 'binary'),
    pack('vvvvVVv', [0, 0, count, count, central.length, offset, 0]),
  ]);

  return Buffer.concat([local, central, end]);
}

export function buildXlsx(columns, rows, sheetName = 'Sheet1') {
  const stripped = String(sheetName).replace(/[\\/?*[\]:]/g, '');
  const safeName = (stripped === '' ? 'Sheet1' : stripped).slice(0, 31);

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',

    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',

    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xlsxEscape(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,

    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',

    // Style 0 = default, 1 = bold header, 2 = date, 3 = date + time.
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd-mmm-yyyy"/>' +
      '<numFmt numFmtId="165" formatCode="dd-mmm-yyyy hh:mm"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs></styleSheet>',

    'xl/worksheets/sheet1.xml': sheetXml(columns, rows),
  };

  return zipFiles(files);
}

/** Sends an XLSX download with the headers browsers need in order to save it. */
export function xlsxDownload(res, filename, columns, rows, sheetName = 'Export') {
  const binary = buildXlsx(columns, rows, sheetName);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${String(filename).replace(/"/g, '')}"`);
  res.set('Content-Length', String(binary.length));
  res.set('Cache-Control', 'no-store');
  return res.end(binary);
}

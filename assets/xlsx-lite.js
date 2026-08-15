/*
 * xlsx-lite.js — dependency-free .xlsx reader/writer.
 *
 * Writing: builds a STORE-only (uncompressed) ZIP by hand, so no deflate
 * implementation is needed. Excel opens these fine.
 * Reading: parses the ZIP central directory and inflates DEFLATE entries with
 * the browser's native DecompressionStream('deflate-raw'), which is what Excel
 * produces when it re-saves the file.
 *
 * Values are written as inline strings, so nothing here depends on number
 * formats or date serials — a date stays the text "2024-03-11" through a full
 * export -> edit in Excel -> import round trip.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Byte helpers
   * ------------------------------------------------------------------ */

  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // MS-DOS packed date/time, used for the ZIP entry timestamps.
  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    return {
      time:
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        (Math.floor(date.getSeconds() / 2) & 0x1f),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function Writer() {
    this.chunks = [];
    this.length = 0;
  }
  Writer.prototype.push = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  Writer.prototype.u16 = function (value) {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  };
  Writer.prototype.u32 = function (value) {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff
      ])
    );
  };
  Writer.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.length);
    var offset = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * ZIP: write (STORE only)
   * ------------------------------------------------------------------ */

  function zipStore(files) {
    var stamp = dosDateTime(new Date());
    var body = new Writer();
    var central = new Writer();
    var entries = [];

    files.forEach(function (file) {
      var nameBytes = textEncoder.encode(file.name);
      var data =
        file.data instanceof Uint8Array ? file.data : textEncoder.encode(file.data);
      var crc = crc32(data);

      entries.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: body.length });

      body.u32(0x04034b50); // local file header
      body.u16(20); // version needed
      body.u16(0x0800); // flags: UTF-8 names
      body.u16(0); // method: store
      body.u16(stamp.time);
      body.u16(stamp.date);
      body.u32(crc);
      body.u32(data.length);
      body.u32(data.length);
      body.u16(nameBytes.length);
      body.u16(0);
      body.push(nameBytes);
      body.push(data);
    });

    entries.forEach(function (entry) {
      central.u32(0x02014b50); // central directory header
      central.u16(20); // version made by
      central.u16(20); // version needed
      central.u16(0x0800);
      central.u16(0);
      central.u16(stamp.time);
      central.u16(stamp.date);
      central.u32(entry.crc);
      central.u32(entry.size);
      central.u32(entry.size);
      central.u16(entry.nameBytes.length);
      central.u16(0); // extra
      central.u16(0); // comment
      central.u16(0); // disk number
      central.u16(0); // internal attrs
      central.u32(0); // external attrs
      central.u32(entry.offset);
      central.push(entry.nameBytes);
    });

    var out = new Writer();
    out.push(body.toUint8Array());
    var centralOffset = body.length;
    var centralBytes = central.toUint8Array();
    out.push(centralBytes);
    out.u32(0x06054b50); // end of central directory
    out.u16(0);
    out.u16(0);
    out.u16(entries.length);
    out.u16(entries.length);
    out.u32(centralBytes.length);
    out.u32(centralOffset);
    out.u16(0);
    return out.toUint8Array();
  }

  /* ------------------------------------------------------------------ *
   * ZIP: read
   * ------------------------------------------------------------------ */

  function findEndOfCentralDirectory(view, length) {
    // The EOCD record is at the end, after an optional comment of <= 65535 bytes.
    var start = Math.max(0, length - 22 - 65535);
    for (var i = length - 22; i >= start; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'This browser cannot read compressed .xlsx files. Please use a recent ' +
          'Chrome, Edge, Firefox or Safari.'
      );
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function unzip(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);
    var eocd = findEndOfCentralDirectory(view, bytes.length);
    if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);
    var files = {};

    for (var i = 0; i < count; i++) {
      var method = view.getUint16(offset + 10, true);
      var compressedSize = view.getUint32(offset + 20, true);
      var nameLength = view.getUint16(offset + 28, true);
      var extraLength = view.getUint16(offset + 30, true);
      var commentLength = view.getUint16(offset + 32, true);
      var localOffset = view.getUint32(offset + 42, true);
      var name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

      // Local header lengths can differ from the central directory's; read them.
      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLength + localExtraLength;
      var raw = bytes.subarray(dataStart, dataStart + compressedSize);

      files[name] = method === 0 ? raw : await inflateRaw(raw);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  }

  /* ------------------------------------------------------------------ *
   * Sheet XML
   * ------------------------------------------------------------------ */

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Control characters are illegal in XML 1.0 and make Excel reject the file.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function columnName(index) {
    var name = '';
    index += 1;
    while (index > 0) {
      var remainder = (index - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      index = Math.floor((index - 1) / 26);
    }
    return name;
  }

  function columnIndex(ref) {
    var letters = /^[A-Z]+/.exec(ref);
    if (!letters) return 0;
    var index = 0;
    for (var i = 0; i < letters[0].length; i++) {
      index = index * 26 + (letters[0].charCodeAt(i) - 64);
    }
    return index - 1;
  }

  function sheetXml(rows) {
    var body = rows
      .map(function (row, rowIndex) {
        var cells = row
          .map(function (value, colIndex) {
            if (value === null || value === undefined || value === '') return '';
            var ref = columnName(colIndex) + (rowIndex + 1);
            if (typeof value === 'number' && isFinite(value)) {
              return '<c r="' + ref + '"><v>' + value + '</v></c>';
            }
            return (
              '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
              escapeXml(value) +
              '</t></is></c>'
            );
          })
          .join('');
        return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
      })
      .join('');

    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + body + '</sheetData></worksheet>'
    );
  }

  /**
   * Build an .xlsx file.
   * @param {Array<{name: string, rows: Array<Array<string|number>>}>} sheets
   * @returns {Blob}
   */
  function build(sheets) {
    var files = [];

    files.push({
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(function (_, i) {
            return (
              '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
              'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            );
          })
          .join('') +
        '</Types>'
    });

    files.push({
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    });

    files.push({
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets
          .map(function (sheet, i) {
            return (
              '<sheet name="' + escapeXml(sheet.name) + '" sheetId="' + (i + 1) +
              '" r:id="rId' + (i + 1) + '"/>'
            );
          })
          .join('') +
        '</sheets></workbook>'
    });

    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(function (_, i) {
            return (
              '<Relationship Id="rId' + (i + 1) +
              '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
              'Target="worksheets/sheet' + (i + 1) + '.xml"/>'
            );
          })
          .join('') +
        '</Relationships>'
    });

    sheets.forEach(function (sheet, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(sheet.rows) });
    });

    return new Blob([zipStore(files)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /* ------------------------------------------------------------------ *
   * Parsing
   * ------------------------------------------------------------------ */

  function parseXml(bytes) {
    var doc = new DOMParser().parseFromString(textDecoder.decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('The spreadsheet contains XML this app could not read.');
    }
    return doc;
  }

  function readSharedStrings(files) {
    var part = files['xl/sharedStrings.xml'];
    if (!part) return [];
    var doc = parseXml(part);
    return Array.prototype.map.call(doc.getElementsByTagName('si'), function (si) {
      // Rich text splits a string across several <t> runs; concatenate them.
      return Array.prototype.map
        .call(si.getElementsByTagName('t'), function (t) {
          return t.textContent;
        })
        .join('');
    });
  }

  function sheetOrder(files) {
    var workbook = files['xl/workbook.xml'];
    var rels = files['xl/_rels/workbook.xml.rels'];
    if (!workbook || !rels) return null;

    var relTargets = {};
    Array.prototype.forEach.call(
      parseXml(rels).getElementsByTagName('Relationship'),
      function (rel) {
        var target = rel.getAttribute('Target') || '';
        relTargets[rel.getAttribute('Id')] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
      }
    );

    return Array.prototype.map.call(
      parseXml(workbook).getElementsByTagName('sheet'),
      function (sheet) {
        var id =
          sheet.getAttribute('r:id') ||
          sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        return { name: sheet.getAttribute('name') || '', path: 'xl/' + relTargets[id] };
      }
    );
  }

  function readSheetRows(bytes, sharedStrings) {
    var doc = parseXml(bytes);
    var rows = [];

    Array.prototype.forEach.call(doc.getElementsByTagName('row'), function (rowEl) {
      var cells = [];
      Array.prototype.forEach.call(rowEl.getElementsByTagName('c'), function (cell) {
        var ref = cell.getAttribute('r');
        var index = ref ? columnIndex(ref) : cells.length;
        var type = cell.getAttribute('t');
        var value = '';

        if (type === 'inlineStr') {
          var is = cell.getElementsByTagName('is')[0];
          value = is ? is.textContent : cell.textContent;
        } else {
          var v = cell.getElementsByTagName('v')[0];
          // Some writers drop the <v> wrapper on literal-string cells.
          var raw = v ? v.textContent : type === 'str' ? cell.textContent : '';
          if (type === 's') {
            value = sharedStrings[parseInt(raw, 10)] || '';
          } else if (type === 'b') {
            value = raw === '1' ? 'TRUE' : 'FALSE';
          } else {
            value = raw;
          }
        }

        while (cells.length < index) cells.push('');
        cells[index] = value;
      });

      var rowIndex = parseInt(rowEl.getAttribute('r'), 10);
      if (rowIndex > 0) {
        while (rows.length < rowIndex - 1) rows.push([]);
        rows[rowIndex - 1] = cells;
      } else {
        rows.push(cells);
      }
    });

    return rows;
  }

  /**
   * Read an .xlsx file into plain rows.
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<Array<{name: string, rows: string[][]}>>}
   */
  async function read(arrayBuffer) {
    var files = await unzip(arrayBuffer);
    var sharedStrings = readSharedStrings(files);
    var order = sheetOrder(files);

    if (!order || !order.length) {
      // Fall back to whatever worksheet parts exist, in name order.
      order = Object.keys(files)
        .filter(function (name) {
          return /^xl\/worksheets\/.*\.xml$/.test(name);
        })
        .sort()
        .map(function (path, i) {
          return { name: 'Sheet' + (i + 1), path: path };
        });
    }

    return order
      .filter(function (sheet) {
        return files[sheet.path];
      })
      .map(function (sheet) {
        return { name: sheet.name, rows: readSheetRows(files[sheet.path], sharedStrings) };
      });
  }

  global.XlsxLite = { build: build, read: read, columnName: columnName };
})(window);

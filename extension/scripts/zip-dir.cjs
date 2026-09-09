/**
 * Minimal, dependency-free ZIP writer.
 *
 * Exists because the previous packaging path shelled out to PowerShell's
 * Compress-Archive, which on Windows PowerShell 5.1 writes `\` as the path
 * separator inside the archive. That is out of spec (ZIP requires `/`), and the
 * Chrome Web Store is not reliably tolerant of it — the 0.0.0.3 zip that shipped
 * has forward slashes, so a rebuilt archive must too.
 *
 * Writing the container here keeps packaging deterministic and free of any
 * external tool (`zip` is not installed on Windows, GNU tar cannot write ZIPs).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Collects files depth-first, returning archive-relative POSIX paths. */
function listFiles(root, prefix = '', out = []) {
  const entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  // Sort for a stable archive across machines.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listFiles(root, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** MS-DOS date/time, the only timestamp a base ZIP record can carry. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(buf) {
  // Node >= 20.15 ships zlib.crc32; fall back to a table for older runtimes.
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c;
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crc32.table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Writes every file under `sourceDir` into a ZIP at `zipPath`.
 * Returns the archive-relative names written, in order.
 */
function zipDirectory(sourceDir, zipPath) {
  const names = listFiles(sourceDir);
  if (names.length === 0) throw new Error(`Nothing to zip — ${sourceDir} is empty`);

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const name of names) {
    const full = path.join(sourceDir, name);
    const content = fs.readFileSync(full);
    const deflated = zlib.deflateRawSync(content, { level: 9 });
    // Only take the compression if it actually helps; method 0 is stored.
    const useDeflate = deflated.length < content.length;
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;

    const crc = crc32(content);
    const { time, date } = dosDateTime(fs.statSync(full).mtime);
    // Archive paths are always POSIX — this is the whole point of the file.
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localChunks.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    // `<< 16` overflows into a signed negative, so coerce back to unsigned.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 0644
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  fs.writeFileSync(zipPath, Buffer.concat([...localChunks, centralDirectory, end]));
  return names;
}

module.exports = { zipDirectory };

// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * rabi-wasm-names.mjs — rename a WebAssembly module's import and export names.
 *
 * The office kit's soffice.wasm exports its entry points as dsh_lok_* and
 * dsh_pdf_* and imports env.dsh_lok_callback; the JS glue calls them by name,
 * and the fork renames the glue. Names are length-prefixed inside their
 * section, so the import and export sections are re-encoded (and their size
 * fields with them) rather than patched byte for byte. Every other section is
 * copied unchanged.
 */

function readU32(buf, pos) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, pos];
}

function encodeU32(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return Buffer.from(out);
}

const encodeName = (name) => {
  const bytes = Buffer.from(name, "utf8");
  return Buffer.concat([encodeU32(bytes.length), bytes]);
};

function readName(buf, pos) {
  const [len, start] = readU32(buf, pos);
  return [buf.toString("utf8", start, start + len), start + len];
}

/** Position just past one import descriptor (after module and field names). */
function skipImportDesc(buf, pos) {
  const kind = buf[pos++];
  const skipLimits = (p) => {
    const flags = buf[p++];
    [, p] = readU32(buf, p);
    if (flags & 1) [, p] = readU32(buf, p);
    return p;
  };
  if (kind === 0) return readU32(buf, pos)[1]; // func: type index
  if (kind === 1) return skipLimits(pos + 1); // table: reftype, limits
  if (kind === 2) return skipLimits(pos); // memory: limits
  if (kind === 3) return pos + 2; // global: valtype, mutability
  if (kind === 4) return readU32(buf, pos + 1)[1]; // tag: attribute, type index
  throw new Error(`unknown wasm import kind ${kind}`);
}

function rewriteImports(body, rename) {
  let [count, pos] = readU32(body, 0);
  const parts = [encodeU32(count)];
  for (let i = 0; i < count; i++) {
    let module;
    let field;
    [module, pos] = readName(body, pos);
    [field, pos] = readName(body, pos);
    const descStart = pos;
    pos = skipImportDesc(body, pos);
    parts.push(encodeName(rename(module)), encodeName(rename(field)), body.subarray(descStart, pos));
  }
  return Buffer.concat(parts);
}

function rewriteExports(body, rename) {
  let [count, pos] = readU32(body, 0);
  const parts = [encodeU32(count)];
  for (let i = 0; i < count; i++) {
    let name;
    [name, pos] = readName(body, pos);
    const descStart = pos;
    pos = readU32(body, pos + 1)[1]; // kind byte, index
    parts.push(encodeName(rename(name)), body.subarray(descStart, pos));
  }
  return Buffer.concat(parts);
}

/** `buf` with every import/export name passed through `rename`; `buf` itself if none changed. */
export function rewriteWasmNames(buf, rename) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module");
  const parts = [buf.subarray(0, 8)];
  let changed = false;
  let pos = 8;
  while (pos < buf.length) {
    const id = buf[pos];
    const [size, bodyStart] = readU32(buf, pos + 1);
    const body = buf.subarray(bodyStart, bodyStart + size);
    let next = body;
    if (id === 2) next = rewriteImports(body, rename);
    else if (id === 7) next = rewriteExports(body, rename);
    if (next !== body && !next.equals(body)) {
      changed = true;
      parts.push(Buffer.from([id]), encodeU32(next.length), next);
    } else {
      parts.push(buf.subarray(pos, bodyStart + size));
    }
    pos = bodyStart + size;
  }
  return changed ? Buffer.concat(parts) : buf;
}

/** Import and export names of a module, for checks. */
export function wasmNames(buf) {
  const names = [];
  rewriteWasmNames(buf, (name) => {
    names.push(name);
    return name;
  });
  return names;
}

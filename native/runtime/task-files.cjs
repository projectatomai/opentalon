const { createHash, randomUUID } = require('node:crypto')
const { extname } = require('node:path')
const { AppError } = require('./contracts.cjs')

const maxBytes = 10 * 1024 * 1024
const videoExtensions = new Set('3g2 3gp 3gpp asf avi dv f4v flv m2ts m4v mkv mov mp4 mpe mpeg mpg mts mxf ogv rm rmvb vob webm wmv'.split(' '))
const columns = 'id, task_id AS taskId, name, content_type AS contentType, byte_count AS byteCount, sha256, created_at AS createdAt'

function migrate(store) {
  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db.exec(`
      CREATE TABLE task_files (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND ${maxBytes}),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) = byte_count)
      ) STRICT;
      CREATE INDEX task_files_by_task ON task_files(task_id, created_at, id);
      PRAGMA user_version=14;
    `)
    store.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(14, new Date().toISOString())
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
}

function validate({ name, contentType, base64 }) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' ||
      !name.isWellFormed() || Buffer.byteLength(name) > 240 || /[/\\:\p{Cc}]/u.test(name))
    throw new AppError('INVALID_ARGUMENT', 'Choose a file with a valid filename of up to 240 bytes.')
  if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) || contentType.length > 150)
    throw new AppError('INVALID_ARGUMENT', 'Use a valid media type for the file.')
  if (contentType.toLowerCase().startsWith('video/') || videoExtensions.has(extname(name.trim()).slice(1).toLowerCase()))
    throw new AppError('INVALID_ARGUMENT', 'Video files cannot be attached.')
  if (typeof base64 !== 'string' || base64.length > Math.ceil(maxBytes / 3) * 4)
    throw new AppError('INVALID_ARGUMENT', 'Files can be up to 10 MB each.')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > maxBytes || bytes.toString('base64') !== base64)
    throw new AppError('INVALID_ARGUMENT', 'Use valid base64 for a file up to 10 MB.')
  // Common video containers can be identified even if a provider mislabels them.
  const magic = bytes.subarray(0, 12).toString('latin1')
  if (magic.startsWith('FLV\x01') || magic.startsWith('RIFF') && magic.slice(8) === 'AVI ' ||
      (magic.slice(4, 8) === 'ftyp' && /^(avc1|mp4[12]|M4V |qt  |3g[p2])/.test(magic.slice(8))))
    throw new AppError('INVALID_ARGUMENT', 'Video files cannot be attached.')
  return bytes
}

function insert(store, metadata, bytes) {
  const { id, taskId, name, contentType, byteCount, sha256, createdAt } = metadata
  store.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?)')
    .run(id, taskId, name, contentType, byteCount, sha256, createdAt, bytes)
}

function attach(store, input) {
  const task = store.task(input.taskId)
  if (task.deleted) throw new AppError('IN_TRASH', 'Restore the task before attaching a file.')
  const bytes = validate(input)
  const attachment = {
    id: randomUUID(), taskId: task.id, name: input.name, contentType: input.contentType,
    byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date().toISOString(),
  }
  insert(store, attachment, bytes)
  return attachment
}

function list(store, taskId) {
  if (taskId === undefined) return store.db.prepare(`SELECT ${columns} FROM task_files ORDER BY created_at,id`).all()
  return store.db.prepare(`SELECT ${columns} FROM task_files WHERE task_id=? ORDER BY created_at,id`).all(taskId)
}

function encode({ bytes, ...attachment }) {
  return { ...attachment, base64: Buffer.from(bytes).toString('base64') }
}

function read(store, taskId, fileId) {
  const row = store.db.prepare(`SELECT ${columns}, bytes FROM task_files WHERE task_id=? AND id=?`).get(taskId, fileId)
  if (!row) throw new AppError('NOT_FOUND', 'This file is no longer attached to the task.')
  return encode(row)
}

function exportRows(store) {
  return store.db.prepare(`SELECT ${columns}, bytes FROM task_files ORDER BY created_at,id`).all().map(encode)
}

function validateRows(rows, tasks) {
  const taskIds = new Set(tasks.map(task => task.id))
  const fileIds = new Set()
  if (!Array.isArray(rows)) throw new AppError('INVALID_BACKUP', 'This backup is missing the task files table.')
  for (const row of rows) {
    const bytes = validate(row ?? {})
    if (typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || fileIds.has(row.id) ||
        !taskIds.has(row.taskId) || !Number.isFinite(Date.parse(row.createdAt)) ||
        bytes.length !== row.byteCount || createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw new AppError('INVALID_BACKUP', 'This backup contains an invalid task file.')
    fileIds.add(row.id)
  }
}

function restoreRows(store, rows) {
  for (const row of rows) insert(store, row, Buffer.from(row.base64, 'base64'))
}

module.exports = { migrate, attach, list, read, exportRows, validateRows, restoreRows }

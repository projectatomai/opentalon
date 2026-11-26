const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { tools, validateAction, AppError } = require('./contracts.cjs')
const MAX_BODY = 15 * 1024 * 1024
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26']
const sqliteErrors = {
  1: ['SQLITE_ERROR', 'SQLite could not execute the operation. Check for an OpenTalon update.'],
  5: ['SQLITE_BUSY', 'Another connection is using the workspace database. Wait briefly, then retry.'],
  6: ['SQLITE_LOCKED', 'A database operation is holding a lock. Let it finish, then retry.'],
  8: ['SQLITE_READONLY', 'SQLite cannot write to the workspace database. Check the data folder permissions and whether its drive is read-only.'],
  10: ['SQLITE_IOERR', 'SQLite encountered a disk I/O error. Check the workspace drive and available space.'],
  11: ['SQLITE_CORRUPT', 'SQLite detected database corruption. Check the workspace in OpenTalon and review your available backups.'],
  13: ['SQLITE_FULL', 'SQLite ran out of space. Free space on the workspace drive and retry.'],
  14: ['SQLITE_CANTOPEN', 'SQLite could not open a database file. Check that the data folder is accessible.'],
  19: ['SQLITE_CONSTRAINT', 'A database constraint prevented the operation. Refresh the affected records before retrying.'],
  787: ['SQLITE_CONSTRAINT_FOREIGNKEY', 'A referenced database record could not be linked. Refresh the task and any linked records before retrying.'],
}
function errorView(error, operation) {
  if (error.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)) {
    // SQLite stores the primary result code in the low byte of an extended code.
    const [sqliteCode, hint] = sqliteErrors[error.errcode] ?? sqliteErrors[error.errcode & 0xff] ??
      ['SQLite result', 'SQLite could not complete the operation. Check the workspace in OpenTalon.']
    // Ordinary mutations save their receipt in the same transaction. Backups
    // and restore confirmations can also write files outside that transaction.
    const sameRequestKeySafe = tools.some(({ name, mutates }) => name === operation && mutates) &&
      operation !== 'create_backup' && operation !== 'confirm_destructive_action'
    return {
      code: error.code,
      message: `${sqliteCode} (${error.errcode}). ${hint}` +
        (sameRequestKeySafe ? ' An identical retry with the same requestKey is safe.' : ''),
      details: {
        sqliteCode, sqliteResultCode: error.errcode,
        ...(sameRequestKeySafe ? { sameRequestKeySafe } : {}),
      },
    }
  }
  if (operation === 'create_backup' && !(error instanceof AppError)) {
    const hint = {
      ENOENT: 'The backup destination is unavailable. Reconnect its drive or choose an existing destination folder.',
      ENOTDIR: 'Part of the backup destination is not a folder. Choose an existing destination folder.',
      EACCES: 'OpenTalon lacks permission to write the backup. Choose a writable destination.',
      EPERM: 'OpenTalon lacks permission to write the backup. Choose a writable destination.',
      EROFS: 'The backup destination is read-only. Choose a writable destination.',
      ENOSPC: 'The backup could not be written because the disk is full. Free space or choose another destination.',
      EIO: 'The backup encountered a disk I/O error. Check the destination drive before retrying.',
    }[error.code]
    if (hint) return { code: error.code, message: hint }
  }
  return {
    code: error.code || 'SAVE_FAILED',
    message:
      error instanceof AppError
        ? error.message
        : 'OpenTalon could not complete the local operation. Check the app and verify the result before retrying.',
    ...(error.details ? { details: error.details } : {}),
  }
}
class Connector {
  constructor({
    folder,
    call,
    executable = process.execPath,
    launchArgs = [],
    stdioCommand,
    version = '0.1.0',
    changed = () => {},
    toolCatalog = tools,
  }) {
    Object.assign(this, { folder, call, executable, launchArgs, stdioCommand, version, changed, toolCatalog })
    this.file = path.join(folder, 'mcp.json')
    this.server = null
    this.error = ''
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new AppError(
          'CONNECTION_CONFIG',
          'Could not read the existing connection configuration. It has not been replaced.'
        )
    }
    this.config = {
      enabled: saved.enabled === true,
      token:
        typeof saved.token === 'string' && saved.token.length >= 32
          ? saved.token
          : randomBytes(32).toString('hex'),
      port: 0,
      executable,
      launchArgs,
      profile: folder,
    }
    this.persist()
  }
  persist() {
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.config), { mode: 0o600 })
    fs.chmodSync(temp, 0o600)
    fs.renameSync(temp, this.file)
    fs.chmodSync(this.file, 0o600)
  }
  async start() {
    if (!this.config.enabled || this.server) return this.status()
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) this.send(response, 500, { error: 'Local connection failed.' })
        else response.destroy()
      })
    })
    server.requestTimeout = 30000
    server.headersTimeout = 10000
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      this.server = server
      this.config.port = server.address().port
      this.error = ''
      this.persist()
    } catch (error) {
      server.close()
      this.error = 'Could not start the local connector. Toggle the connection to retry.'
      throw error
    }
    this.changed()
    return this.status()
  }
  async enable(enabled) {
    this.config.enabled = enabled
    if (!enabled) {
      this.persist()
      await this.stop()
    } else {
      this.persist()
      await this.start()
    }
    this.changed()
    return this.status()
  }
  async stop() {
    const server = this.server
    this.server = null
    this.config.port = 0
    this.persist()
    if (server)
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  }
  reset() {
    this.config.token = randomBytes(32).toString('hex')
    this.persist()
    this.changed()
    return this.status()
  }
  status() {
    return {
      enabled: this.config.enabled,
      running: !!this.server,
      endpoint: this.server ? `http://127.0.0.1:${this.config.port}/mcp` : null,
      error: this.error,
      configFile: this.file,
    }
  }
  configuration(transport) {
    if (!this.config.enabled || !this.server)
      throw new AppError('CONNECTION_DISABLED', 'Enable the connection first.')
    if (transport === 'http')
      return {
        mcpServers: {
          opentalon: {
            type: 'http',
            url: `http://127.0.0.1:${this.config.port}/mcp`,
            headers: { Authorization: `Bearer ${this.config.token}` },
          },
        },
      }
    return {
      mcpServers: {
        opentalon: {
          command: this.stdioCommand || this.executable,
          args: [path.join(__dirname, 'mcp-bridge.cjs')],
          env: {
            ...(this.stdioCommand ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
            OPENTALON_MCP_CONFIG: this.file,
          },
        },
      },
    }
  }
  send(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  authorized(request) {
    const actual = Buffer.from(request.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${this.config.token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  async handle(request, response) {
    if (!this.config.enabled || !this.server)
      return this.send(response, 503, { error: 'Connection disabled.' })
    if (
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${this.config.port}`
    )
      return this.send(response, 403, { error: 'Only local non-browser clients are allowed.' })
    if (!this.authorized(request))
      return this.send(response, 401, { error: 'Invalid connection key.' })
    if (request.url !== '/mcp') return this.send(response, 404, { error: 'Unknown endpoint.' })
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return this.send(response, 405, { error: 'Use POST. Server event streaming is not offered.' })
    }
    if (!request.headers['content-type']?.startsWith('application/json'))
      return this.send(response, 415, { error: 'Use application/json.' })
    if (
      !request.headers.accept?.includes('application/json') ||
      !request.headers.accept?.includes('text/event-stream')
    )
      return this.send(response, 406, { error: 'Accept application/json and text/event-stream.' })
    if (
      request.headers['mcp-protocol-version'] &&
      !PROTOCOLS.includes(request.headers['mcp-protocol-version'])
    )
      return this.send(response, 400, { error: 'Unsupported MCP protocol version.' })
    if (Number(request.headers['content-length'] || 0) > MAX_BODY) {
      request.resume()
      return this.send(response, 413, { error: 'Request exceeds 15 MB.' })
    }
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) {
        this.send(response, 413, { error: 'Request exceeds 15 MB.' })
        return
      }
      chunks.push(chunk)
    }
    let message
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return this.send(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error.' },
      })
    }
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')
    )
      return this.send(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      })
    if (message.id === undefined) return this.send(response, 202)
    const rpcError = (code, text) =>
      this.send(response, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    let result
    if (message.method === 'initialize') {
      if (!message.params || typeof message.params.protocolVersion !== 'string')
        return rpcError(-32602, 'protocolVersion is required.')
      result = {
        protocolVersion: PROTOCOLS.includes(message.params.protocolVersion)
          ? message.params.protocolVersion
          : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'OpenTalon', version: this.version },
        instructions:
          'A single-person offline task manager. Read revisions before editing. Reuse requestKey for identical retries. Show destructive previews and obtain explicit confirmation before confirming. Connection credentials are never task data.',
      }
    } else if (message.method === 'ping') result = {}
    else if (message.method === 'tools/list')
      result = {
        tools: this.toolCatalog.map(({ mutates, ...tool }) => ({
          ...tool,
          annotations: {
            readOnlyHint: !mutates,
            destructiveHint: tool.name === 'confirm_destructive_action',
            idempotentHint: mutates,
            openWorldHint: false,
          },
        })),
      }
    else if (message.method === 'tools/call') {
      const { name, arguments: args = {} } = message.params || {}
      try {
        validateAction(name, args)
        if (!this.toolCatalog.some((tool) => tool.name === name))
          throw new AppError('TOOL_UNAVAILABLE', 'This tool is unavailable in this connection.')
        const value = await this.call(name, args)
        result = {
          content:
            name === 'read_comment_image'
              ? [{ type: 'image', mimeType: value.mimeType, data: value.data }]
              : [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent:
            name === 'read_comment_image'
              ? { id: value.id, name: value.name, mimeType: value.mimeType }
              : value,
        }
      } catch (error) {
        const value = errorView(error, name)
        result = {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
        }
      }
    } else return rpcError(-32601, 'Method not found.')
    return this.send(response, 200, { jsonrpc: '2.0', id: message.id, result })
  }
}
module.exports = { Connector, errorView }

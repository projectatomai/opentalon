// Gemini runs through Google's Antigravity CLI (agy), the signed-in successor to the
// Gemini CLI. Tasks and chat use `agy acp`: JSON-RPC 2.0 over stdio with a session-scoped
// MCP list, permission requests, resume and cancel. Drafting uses documented print mode.
// Verified November 23, 2026 against agy 1.5.15 (`agy --help`, `agy acp --help`, a live
// initialize and signed-out session/new) and the official docs:
// https://antigravity.google/docs/cli/acp/ https://antigravity.google/docs/cli/headless/
// https://agentclientprotocol.com/protocol/v1/
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AppError } = require('./contracts.cjs')

const protocolVersion = 1
const signInMethods = ['oauth-personal', 'oauth-business']
// OpenTalon supports the cached Google sign-in only. These would switch agy to an API
// key, default credentials or another endpoint without the owner choosing that here.
const unsupportedAuthEnvironment = ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_GEMINI_BASE_URL']
const transportOptions = { jsonrpc: true, withoutEnvironment: unsupportedAuthEnvironment }
const thinkingLevels = {
  low: ['low'], medium: ['medium'], high: ['high'], xhigh: ['xhigh', 'extra'], max: ['max'],
}

function geminiArguments(permissionMode, scopedSettings = []) {
  // Full access is the only mode that skips approval. Every other mode keeps agy's
  // terminal sandbox on and routes approvals back to OpenTalon.
  return [...scopedSettings, 'acp', permissionMode === 'full-access' ? '--dangerously-skip-permissions' : '--sandbox']
}

function geminiToolServer(config) {
  return {
    name: 'opentalon',
    command: config.command,
    args: config.args ?? [],
    env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })),
  }
}

// Session-only CLI permissions keep user-installed servers out of this task without
// changing their registration or the owner's saved rules.
function geminiScopedSettings(cwd, home = os.homedir()) {
  const files = [path.join(home, '.gemini', 'config'), path.join(cwd, '.agents')].flatMap((folder) => {
    let plugins = []
    try {
      plugins = fs.readdirSync(path.join(folder, 'plugins'))
        .map((plugin) => path.join(folder, 'plugins', plugin, 'mcp_config.json'))
    } catch {}
    return [path.join(folder, 'mcp_config.json'), ...plugins]
  })
  const names = new Set()
  for (const file of files) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (!text.trim()) continue
    let servers
    try { servers = JSON.parse(text).mcpServers ?? {} } catch { servers = null }
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new AppError('AGENT_TOOL_SERVERS', `Gemini’s tool server settings could not be read (${file}). Fix or remove that file, then send this again.`)
    for (const [name, server] of Object.entries(servers)) if (server?.disabled !== true) names.add(name)
  }
  if (!names.size) return []
  if (names.has('opentalon') || [...names].some(name => !/^[\w.-]+$/.test(name)))
    throw new AppError('AGENT_TOOL_SERVERS', 'A saved Gemini server conflicts with the scoped OpenTalon task connection. Rename that server before sending this task.')
  const permissions = {}
  for (const file of [path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), path.join(cwd, '.agents', 'settings.json')]) {
    if (!fs.existsSync(file)) continue
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).permissions ?? {}
      for (const key of ['deny', 'ask', 'allow']) {
        if (saved[key] === undefined) continue
        if (!Array.isArray(saved[key]) || saved[key].some(rule => typeof rule !== 'string')) throw Error()
        permissions[key] = [...new Set([...(permissions[key] || []), ...saved[key]])]
      }
    } catch { throw new AppError('AGENT_TOOL_SERVERS', 'Gemini’s saved permission rules could not be read safely.') }
  }
  permissions.deny = [...new Set([...(permissions.deny || []), ...[...names].map(name => `mcp(${name}/*)`)])]
  return ['--settings', JSON.stringify({permissions})]
}

function geminiFailure(error) {
  if (error instanceof AppError) return error
  if (/authenticat|auth_required|not signed in|log ?in required/i.test(error?.message ?? ''))
    return new AppError('AGENT_AUTH_REQUIRED', 'Gemini needs you to sign in. Run agy in Terminal, sign in with Google, then send this again.')
  return error
}

function assertGeminiRuntime(result) {
  if (result?.protocolVersion !== protocolVersion)
    throw new AppError('AGENT_UNSUPPORTED', 'This Antigravity CLI is not compatible with OpenTalon. Update it with agy update, then send this again.')
  if (!result.authMethods?.some((method) => signInMethods.includes(method?.id)))
    throw new AppError('AGENT_AUTH_UNSUPPORTED', 'This Antigravity CLI does not offer Google sign-in, the only Gemini sign-in OpenTalon supports.')
  return result.agentCapabilities ?? {}
}

async function geminiInitialize(transport) {
  return assertGeminiRuntime(await transport.request('initialize', {
    protocolVersion,
    // No file or terminal delegation: agy uses its own sandboxed tools.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'opentalon', title: 'OpenTalon', version: '0.1.0' },
  }))
}

// Starts or reopens one conversation. Never calls `authenticate`: that opens a browser
// sign-in the owner did not ask for. A signed-out CLI fails here instead.
async function geminiSession(transport, capabilities, { cwd, server, sessionId }) {
  const params = { cwd, mcpServers: [server] }
  try {
    if (!sessionId) {
      const session = await transport.request('session/new', params)
      if (typeof session?.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(session.sessionId))
        throw new AppError('AGENT_UNSUPPORTED', 'Gemini did not return a conversation OpenTalon can save.')
      return session
    }
    const resume = capabilities.sessionCapabilities?.resume ? 'session/resume'
      : capabilities.loadSession ? 'session/load' : null
    if (!resume)
      throw new AppError('AGENT_UNSUPPORTED', 'This Antigravity CLI cannot reopen a saved conversation. Update it with agy update.')
    const session = (await transport.request(resume, { ...params, sessionId })) ?? {}
    if (session.sessionId !== undefined && session.sessionId !== sessionId)
      throw new AppError('AGENT_RESUME_MISMATCH', 'Gemini did not resume the original conversation. Review it before resending the comments.')
    return { ...session, sessionId }
  } catch (error) {
    throw geminiFailure(error)
  }
}

// ACP agents advertise choices as config options, with models/modes as the older form.
function choice(session, category) {
  const option = (session.configOptions ?? [])
    .find((entry) => entry?.category === category && Array.isArray(entry.options))
  if (option) {
    const entries = option.options.flatMap((entry) => Array.isArray(entry.options) ? entry.options : [entry])
    return {
      entries: entries.map((entry) => ({ id: entry.value, name: entry.name })),
      current: option.currentValue,
      set: (id) => ['session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: id }],
    }
  }
  if (category === 'model' && Array.isArray(session.models?.availableModels))
    return {
      entries: session.models.availableModels.map((model) => ({ id: model.modelId, name: model.name })),
      current: session.models.currentModelId,
      set: (id) => ['session/set_model', { sessionId: session.sessionId, modelId: id }],
    }
  if (category === 'mode' && Array.isArray(session.modes?.availableModes))
    return {
      entries: session.modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name })),
      current: session.modes.currentModeId,
      set: (id) => ['session/set_mode', { sessionId: session.sessionId, modeId: id }],
    }
  return null
}

async function choose(transport, session, category, id) {
  const available = choice(session, category)
  if (available.current === id) return
  const result = await transport.request(...available.set(id))
  if (Array.isArray(result?.configOptions)) {
    session.configOptions = result.configOptions
    if (choice(session, category)?.current !== id) throw new Error(`Gemini kept a different ${category}.`)
  }
}

const unavailableModel = (model) => new AppError('AGENT_MODEL_UNAVAILABLE',
  `Gemini does not offer ${model} to this account. Choose another Gemini model, then send this again. OpenTalon did not switch models for you.`)

// Applies exactly the requested model or throws. A slug such as gemini-4-carbon-high may be
// one listed model, or a listed model plus a listed thinking level. Nothing else matches.
async function selectGeminiModel(transport, session, model) {
  if (typeof model !== 'string' || !model)
    throw new AppError('AGENT_MODEL_REQUIRED', 'Choose a Gemini model before sending this.')
  try {
    const models = choice(session, 'model')
    if (!models) throw unavailableModel(model)
    const listed = (id) => models.entries.some((entry) => entry.id === id)
    if (listed(model)) {
      await choose(transport, session, 'model', model)
      return { model }
    }
    const [, base, level] = /^(.+)-(low|medium|high|xhigh|max)$/.exec(model) ?? []
    if (!base || !listed(base)) throw unavailableModel(model)
    await choose(transport, session, 'model', base)
    const thinking = choice(session, 'thought_level')?.entries.find((entry) =>
      [entry.id, entry.name].some((label) => thinkingLevels[level].includes(String(label).toLowerCase())))
    if (!thinking) throw unavailableModel(model)
    await choose(transport, session, 'thought_level', thinking.id)
    return { model: base, thinking: thinking.id }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw unavailableModel(model)
  }
}

// True when a later update shows Gemini moved off the model this run selected.
function geminiModelChanged(update, selected) {
  if (update?.sessionUpdate !== 'config_option_update' || !Array.isArray(update.configOptions)) return false
  const current = (category) => update.configOptions.find((entry) => entry?.category === category)?.currentValue
  return (current('model') !== undefined && current('model') !== selected.model) ||
    (selected.thinking !== undefined && current('thought_level') !== undefined && current('thought_level') !== selected.thinking)
}

async function selectGeminiMode(transport, session, permissionMode) {
  if (permissionMode === 'full-access') return
  const modes = choice(session, 'mode')
  const offered = (id) => modes?.entries.some((entry) => entry.id === id)
  // Without agy's reviewed auto mode, Automatic falls back to asking the owner.
  const mode = permissionMode === 'auto' && offered('auto') ? 'auto' : 'default'
  if (!offered(mode))
    throw new AppError('AGENT_UNSUPPORTED', 'Gemini did not offer an approval mode OpenTalon can enforce. Update the Antigravity CLI with agy update.')
  try {
    await choose(transport, session, 'mode', mode)
  } catch (error) {
    throw new AppError('AGENT_UNSUPPORTED', 'Gemini could not switch to the access mode chosen in Settings.')
  }
}

function permissionOutcome(options, allow) {
  const option = (options ?? []).find((entry) => entry?.kind === (allow ? 'allow_once' : 'reject_once'))
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}

function geminiPrompt(text, images, capabilities) {
  return [
    { type: 'text', text },
    ...(capabilities.promptCapabilities?.image ? images : [])
      .map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
  ]
}

function geminiStop(result, lastText) {
  const reason = result?.stopReason
  if (reason === 'end_turn')
    return ['review', lastText || 'Gemini finished its response. Review the result before marking the task done.']
  if (reason === 'cancelled') return ['canceled', 'Gemini stopped this turn.']
  if (reason === 'refusal') return ['failed', 'Gemini declined this request.']
  return ['failed', `Gemini stopped before finishing${reason ? ` (${reason.replaceAll('_', ' ')})` : ''}. Review its work before sending again.`]
}

// One complete Ask my agent turn. Approvals have no owner to answer them here, so every
// request is declined unless the owner chose Full access.
async function geminiChat({ file, cwd, permissionMode, model, config, prompt, signal, spawnTransport, home, timeout = 90_000 }) {
  const scopedSettings = geminiScopedSettings(cwd, home)
  let text = ''
  let declined = 0
  let prompted = false
  let answered = false
  let session
  let transport
  let exited
  const ended = new Promise((_, reject) => { exited = reject })
  const onMessage = (message) => {
    if (message.id !== undefined && message.method) {
      if (message.method !== 'session/request_permission')
        return transport.write({ id: message.id, error: { code: -32601, message: 'OpenTalon chat does not provide this.' } })
      declined += 1
      return transport.write({ id: message.id, result: permissionOutcome(message.params?.options, false) })
    }
    const update = message.params?.update
    if (message.method !== 'session/update' || !prompted || message.params.sessionId !== session?.sessionId) return
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
      text = (text + update.content.text).slice(-16000)
  }
  transport = spawnTransport(file, geminiArguments(permissionMode, scopedSettings), cwd, onMessage, exited, transportOptions)
  const timer = setTimeout(() => exited(new Error('Gemini did not reply in time.')), timeout)
  const abort = () => exited(new Error('Stopped.'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([ended, (async () => {
      const capabilities = await geminiInitialize(transport)
      session = await geminiSession(transport, capabilities, { cwd, server: geminiToolServer(config) })
      await selectGeminiModel(transport, session, model)
      await selectGeminiMode(transport, session, permissionMode)
      prompted = true
      const result = await transport.request('session/prompt',
        { sessionId: session.sessionId, prompt: geminiPrompt(prompt, [], capabilities) }, false, 0)
      answered = true
      if (declined)
        throw new AppError('CHAT_PERMISSION_REQUIRED', 'Gemini asked for an approval that Ask my agent cannot give. Send this as a task, or choose Full access in Settings.')
      if (result?.stopReason !== 'end_turn' || !text.trim()) throw new Error(geminiStop(result, '')[1])
      return { text: text.trim() }
    })()])
  } catch (error) {
    throw geminiFailure(error)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (session && !answered) try { transport.write({ method: 'session/cancel', params: { sessionId: session.sessionId } }) } catch {}
    transport.close()
  }
}

// Documented print mode: plan mode is read-only and the JSON envelope carries the schema result.
function geminiDraftArguments({ model, schema, prompt }) {
  return [
    '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--model', model,
    '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '40s', '--print', prompt,
  ]
}

function geminiDraftResult(stdout) {
  let reply
  try { reply = JSON.parse(stdout) } catch { throw new Error('Gemini returned an unreadable draft.') }
  if (reply.status !== 'SUCCESS' || !reply.structured_output || typeof reply.structured_output !== 'object')
    throw geminiFailure(new Error(typeof reply.error === 'string' ? reply.error : reply.error?.message ?? 'Gemini returned no draft.'))
  return reply.structured_output
}

module.exports = {
  transportOptions, unsupportedAuthEnvironment, geminiArguments, geminiToolServer, geminiScopedSettings,
  geminiFailure, assertGeminiRuntime, geminiInitialize, geminiSession, selectGeminiModel, geminiModelChanged,
  selectGeminiMode, permissionOutcome, geminiPrompt, geminiStop, geminiChat, geminiDraftArguments, geminiDraftResult,
}

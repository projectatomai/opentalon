const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Store } = require('./store.cjs')
const { AgentRunner, JsonProcess, askAgent, draftTask, executable } = require('./agent-runner.cjs')
const { agentModels, agentIds, validateModelOverrides } = require('./agent-models.cjs')
const { tools, validateAction } = require('./contracts.cjs')
const { assertAgentReady } = require('./agent-readiness.cjs')
const gemini = require('./gemini-agent.cjs')
const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })

// Captured from Google's signed agy 1.5.15 on November 23, 2026, in an empty home folder.
const captured = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `agy-1.5.15-${name}.json`), 'utf8'))
const initialized = captured('initialize').result
const signedOut = captured('signed-out').error
const flash = 'gemini-3.8-flash-high'
const hydrogen = 'gemini-4-hydrogen-high'
const carbon = 'gemini-4-carbon-high'
const sessionId = '0b9f3f0e-5a55-4d5f-9a39-2d5d7e5c1a10'
const modes = (currentModeId = 'default', ids = ['default', 'accept-edits', 'auto', 'plan']) =>
  ({ currentModeId, availableModes: ids.map((id) => ({ id, name: id })) })
const models = (currentModelId = 'gemini-4-neon-medium', ids = [flash, hydrogen, carbon, 'gemini-4-neon-medium']) =>
  ({ currentModelId, availableModels: ids.map((modelId) => ({ modelId, name: modelId })) })
const rejection = (error) => Object.assign(new Error(error.message), { code: error.code })

// A scripted `agy acp` peer. Replies default to a signed-in session with every model.
function fakeAgy(replies = {}) {
  const launched = []
  const spawnTransport = (file, args, cwd, message, exit, options) => {
    const entry = {
      file, args, cwd, message, exit, options, written: [], closed: false, turn: null,
      async request(method, params, claude, timeout) {
        entry.written.push({ method, params, timeout })
        if (replies[method]) return replies[method](params, entry)
        if (method === 'initialize') return initialized
        if (method === 'session/new') return { sessionId, modes: modes(), models: models() }
        if (method === 'session/resume' || method === 'session/load') return { modes: modes(), models: models() }
        if (method === 'session/prompt') return new Promise((resolve, reject) => { entry.turn = { resolve, reject } })
        return {}
      },
      write(line) { entry.written.push(line) },
      close() { entry.closed = true },
      sent: (method) => entry.written.filter((line) => line.method === method),
    }
    launched.push(entry)
    return entry
  }
  return { launched, spawnTransport }
}

function fixture(t, replies, { installed = true } = {}) {
  const folder = fs.mkdtempSync(path.join(base, 'gemini-'))
  const store = new Store(folder)
  const agy = fakeAgy(replies)
  const opened = []
  const runner = new AgentRunner({
    store,
    connector: {
      status: () => ({ running: true }),
      configuration: () => ({
        mcpServers: { opentalon: { command: '/safe/app', args: ['/bridge.cjs'], env: { OPENTALON_MCP_CONFIG: '/run/config.json' } } },
      }),
    },
    openExternal: (url) => opened.push(url),
    resolveExecutable: (agent) => (agent === 'gemini' && !installed ? null : '/safe/' + agent),
    spawnTransport: agy.spawnTransport,
    home: folder,
  })
  t.after(async () => {
    await runner.close()
    store.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const write = (name, input) => store.dispatch(name, { ...input, requestKey: randomUUID() }, 'You · test')
  const settings = (permissionMode) =>
    write('set_agent_settings', { defaultAgent: 'gemini', workingFolder: folder, ...(permissionMode ? { permissionMode } : {}) })
  const send = async (title, extra = {}) => {
    const { task } = await write('create_task', { boardId: store.boards()[0].id, title })
    await write('move_task', { id: task.id, expectedRevision: task.revision, status: 'Sent to agent', ...extra })
    await runner.tick()
    return { task, job: store.agentJobs().find((job) => job.taskId === task.id), transport: agy.launched.at(-1) }
  }
  const update = (transport, body, session = sessionId) =>
    transport.message({ method: 'session/update', params: { sessionId: session, update: body } })
  const said = (transport, text, messageId = 'm1') =>
    update(transport, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
  return { folder, store, runner, opened, write, settings, send, update, said, ...agy }
}

test('Gemini ships as its own agent with Flash first and explicit Antigravity model slugs', () => {
  assert.deepEqual(agentIds, ['claude-code', 'codex', 'gemini'])
  assert.deepEqual(agentModels.filter(({ agent }) => agent === 'gemini').map(({ id, title }) => [id, title]), [
    [flash, 'Gemini 3.8 Flash'], [hydrogen, 'Gemini 4 Hydrogen'], [carbon, 'Gemini 4 Carbon'],
    ['gemini-4-neon-high', 'Gemini 4 Neon'], ['gemini-4-argon-high', 'Gemini 4 Argon'],
  ])
  assert.ok(!agentModels.some(({ id }) => /^gemini-(2|3\.[0-7])/.test(id)), 'Deprecated Gemini models are not offered')
  assert.equal(validateModelOverrides([{ agent: 'gemini', id: 'gemini-4-neon-xhigh', title: 'Neon XHigh' }])[0].agent, 'gemini')
  for (const [name, input] of [
    ['set_agent_settings', { requestKey: 'k', defaultAgent: 'gemini', workingFolder: '/tmp' }],
    ['open_agent_install_guide', { agent: 'gemini' }],
    ['create_task', { requestKey: 'k', boardId: 'b', title: 'T', agent: 'gemini', model: hydrogen }],
  ]) validateAction(name, input, true)
  assert.throws(() => validateAction('set_agent_settings', { requestKey: 'k', defaultAgent: 'bard', workingFolder: '' }, true),
    { code: 'INVALID_ARGUMENT' })
  const overrides = tools.find(({ name }) => name === 'set_agent_models').inputSchema.properties.overrides
  assert.ok(overrides.items.properties.agent.enum.includes('gemini'))
})

test('the Gemini launcher is agy; the retired gemini CLI is never picked up', (t) => {
  const bin = fs.mkdtempSync(path.join(base, 'gemini-bin-'))
  const previous = process.env.PATH
  t.after(() => { process.env.PATH = previous; fs.rmSync(bin, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 })
  process.env.PATH = bin
  assert.notEqual(executable('gemini'), path.join(bin, 'gemini'))
  assert.equal(executable('bard'), null)
  fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(path.basename(executable('gemini')), 'agy')
})

test('a Gemini task launches agy acp with only the OpenTalon server, the default model, and reports status', async (t) => {
  const f = fixture(t)
  await f.settings()
  assert.deepEqual(f.runner.status().gemini, { installed: true, name: 'Gemini' })
  const { task, job, transport } = await f.send('Write the launch notes')
  assert.equal(job.agent, 'gemini')
  assert.equal(job.model, flash, 'Agent default names Gemini 3.8 Flash')
  assert.equal(transport.file, '/safe/gemini')
  assert.deepEqual(transport.args, ['acp', '--sandbox'])
  assert.equal(transport.cwd, fs.realpathSync(f.folder))
  assert.deepEqual(transport.options, {
    jsonrpc: true, withoutEnvironment: ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_GEMINI_BASE_URL'],
  })
  assert.deepEqual(transport.written.map(({ method }) => method),
    ['initialize', 'session/new', 'session/set_model', 'session/set_mode', 'session/prompt'])
  const [initialize, created, model, mode, prompt] = transport.written
  assert.equal(initialize.params.protocolVersion, 1)
  assert.deepEqual(initialize.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
  assert.deepEqual(created.params, {
    cwd: fs.realpathSync(f.folder),
    mcpServers: [{
      name: 'opentalon', command: '/safe/app', args: ['/bridge.cjs'],
      env: [{ name: 'OPENTALON_MCP_CONFIG', value: '/run/config.json' }],
    }],
  })
  assert.deepEqual(model.params, { sessionId, modelId: flash })
  assert.deepEqual(mode.params, { sessionId, modeId: 'auto' })
  assert.equal(prompt.timeout, 0, 'The turn is not cut off by the request timeout')
  assert.equal(prompt.params.sessionId, sessionId)
  assert.match(prompt.params.prompt[0].text, /Write the launch notes/)
  assert.ok(prompt.params.prompt[0].text.includes(job.id))
  assert.equal(f.store.agentJob(job.id).state, 'starting')
  assert.equal(f.store.agentJob(job.id).threadId, sessionId)

  await f.said(transport, 'Reading the task. ')
  assert.equal(f.store.agentJob(job.id).state, 'working')
  assert.equal(f.store.task(task.id).status, 'In progress')
  await f.said(transport, 'Notes are saved.', 'm2')
  await f.said(transport, ' Review them.', 'm2')
  transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  const finished = f.store.agentJob(job.id)
  assert.equal(finished.state, 'review')
  assert.equal(finished.summary, 'Notes are saved. Review them.')
  assert.ok(transport.closed)
  assert.equal(transport.sent('session/cancel').length, 0)
  const activity = (await f.store.dispatch('list_task_activity', { taskId: task.id })).entries
  assert.ok(activity.some((entry) => entry.summary === 'Gemini picked up the task'))
  assert.ok(!activity.some((entry) => /Claude|Codex/.test(entry.summary)))
})

test('the chosen Gemini model is the one sent; a model for another agent is refused', async (t) => {
  const f = fixture(t)
  await f.settings()
  const { task } = await f.write('create_task', { boardId: f.store.boards()[0].id, title: 'Reason through the plan' })
  const move = { id: task.id, expectedRevision: task.revision, status: 'Sent to agent', agent: 'gemini' }
  await assert.rejects(f.write('move_task', { ...move, model: 'gpt-6.2-sol' }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(f.write('move_task', { ...move, agent: 'codex', model: carbon }), { code: 'INVALID_ARGUMENT' })
  await f.write('move_task', { ...move, model: carbon })
  await f.runner.tick()
  assert.deepEqual(f.launched[0].sent('session/set_model').map(({ params }) => params.modelId), [carbon])
})

test('Agent default names Gemini 3.8 Flash; chosen models and the owner’s model list are kept exactly', async (t) => {
  const f = fixture(t, { 'session/new': () => ({ sessionId, modes: modes(), models: models(flash, [flash]) }) })
  await f.settings()
  const unconfigured = await f.send('Agent default')
  assert.equal(unconfigured.job.model, flash)
  assert.equal(unconfigured.transport.sent('session/prompt').length, 1)
  await f.runner.stop(unconfigured.job.id)

  // A chosen model this account lacks stops the run. Flash is on offer and is not used instead.
  const chosen = await f.send('Chosen model', { agent: 'gemini', model: hydrogen })
  assert.equal(chosen.job.model, hydrogen)
  assert.equal(f.store.agentJob(chosen.job.id).state, 'failed')
  assert.match(f.store.agentJob(chosen.job.id).summary, /does not offer gemini-4-hydrogen-high.*did not switch models/)
  assert.equal(chosen.transport.sent('session/set_model').length, 0)
  assert.equal(chosen.transport.sent('session/prompt').length, 0)
  assert.equal(f.store.agentJob(unconfigured.job.id).model, flash, 'An earlier run keeps the model it was sent with')

  // The owner's own list decides Agent default once they change it.
  const saveModels = async (overrides) => f.write('set_agent_models', {
    overrides, expectedCatalogRevision: (await f.store.dispatch('get_agent_models')).catalogRevision,
  })
  await saveModels([{ agent: 'gemini', id: flash, title: 'Gemini 3.8 Flash', hidden: true }])
  const preferred = await f.send('Owner hid Flash')
  assert.equal(preferred.job.model, hydrogen)
  await f.runner.stop(preferred.job.id)
  await assert.rejects(f.write('create_task', {
    boardId: f.store.boards()[0].id, title: 'Hidden model', status: 'Sent to agent', agent: 'gemini', model: flash,
  }), { code: 'INVALID_ARGUMENT' })

  await saveModels(agentModels.filter(({ agent }) => agent === 'gemini').map((model) => ({ ...model, hidden: true })))
  await assert.rejects(f.write('create_task', {
    boardId: f.store.boards()[0].id, title: 'No Gemini models', status: 'Sent to agent',
  }), { code: 'INVALID_ARGUMENT', message: 'Add a Gemini model in Settings before sending this task.' })
})

test('model slugs resolve against config options with a separate thinking level, or not at all', async () => {
  const session = () => ({
    sessionId,
    configOptions: [
      { id: 'model', category: 'model', currentValue: 'gemini-4-neon', options: [
        { group: 'gemini', name: 'Gemini', options: [{ value: 'gemini-4-neon', name: 'Neon' }, { value: 'gemini-4-carbon', name: 'Carbon' }] }] },
      { id: 'thinking', category: 'thought_level', currentValue: 'medium', options: [
        { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }] },
    ],
  })
  const sent = []
  const transport = { request: async (method, params) => { sent.push([method, params]); return {} } }
  assert.deepEqual(await gemini.selectGeminiModel(transport, session(), carbon), { model: 'gemini-4-carbon', thinking: 'high' })
  assert.deepEqual(sent, [
    ['session/set_config_option', { sessionId, configId: 'model', value: 'gemini-4-carbon' }],
    ['session/set_config_option', { sessionId, configId: 'thinking', value: 'high' }],
  ])
  sent.length = 0
  for (const model of ['gemini-4-hydrogen-high', 'gemini-4-carbon-max', 'gemini-4-carbon-', undefined])
    await assert.rejects(gemini.selectGeminiModel(transport, session(), model), /Gemini/)
  await assert.rejects(gemini.selectGeminiModel(transport, session(), 'gemini-4-hydrogen-high'), { code: 'AGENT_MODEL_UNAVAILABLE' })
  await assert.rejects(gemini.selectGeminiModel(transport, { sessionId }, carbon), { code: 'AGENT_MODEL_UNAVAILABLE' })
  assert.ok(!sent.some(([, params]) => params.configId === 'thinking'), 'No partial model is left selected as a success')
  // A reply that reports a different model than the one requested is a failure, not a fallback.
  const stubborn = { request: async () => ({ configOptions: session().configOptions }) }
  await assert.rejects(gemini.selectGeminiModel(stubborn, session(), carbon), { code: 'AGENT_MODEL_UNAVAILABLE' })
})

test('agent default reflects the Google account list while explicit task choices stay fixed', async (t) => {
  const f = fixture(t)
  await f.settings()
  const defaultId = () => f.store.agentModelCatalog().models.find(model => model.agent === 'gemini').id
  assert.equal(defaultId(), 'gemini-3.8-flash-high', 'New offline or signed-out account')
  f.store.googleAccountModels = ['gemini-3.8-flash-high']
  assert.equal(defaultId(), 'gemini-3.8-flash-high', 'Free account')
  f.store.googleAccountModels = ['gemini-4-neon-xhigh', 'gemini-4-neon-high', hydrogen, 'gemini-3.8-flash-high']
  assert.equal(defaultId(), 'gemini-4-neon-high', 'Paid account')
  const { job } = await f.send('Use my explicit choice', { agent: 'gemini', model: hydrogen })
  assert.equal(job.model, hydrogen)
})

test('withdrawing a shared Gemini request cancels the current prompt and continues the other work in the same session', async (t) => {
  const f = fixture(t)
  await f.settings()
  const { job, transport } = await f.send('Review a synthetic checklist', { agent: 'gemini', model: hydrogen })
  const withdrawn = { id: randomUUID(), text: 'Skip the old title.' }
  assert.deepEqual(await f.runner.notifyWithdrawal(randomUUID(), withdrawn), { notified: false })
  assert.deepEqual(await f.runner.notifyWithdrawal(job.id, withdrawn), { notified: true })
  assert.deepEqual(await f.runner.notifyWithdrawal(job.id, withdrawn), { notified: true })
  assert.equal(transport.sent('session/cancel').length, 1)
  transport.turn.resolve({ stopReason: 'cancelled' })
  await new Promise(setImmediate)
  const prompts = transport.sent('session/prompt')
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].params.sessionId, sessionId)
  assert.ok(prompts[1].params.prompt[0].text.includes(withdrawn.id))
  transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  assert.equal(f.store.agentJob(job.id).state, 'review')
})

test('a signed-out agy fails closed with the captured error and never starts a sign-in or a turn', async (t) => {
  const f = fixture(t, { 'session/new': () => { throw rejection(signedOut) } })
  await f.settings()
  const { task, job, transport } = await f.send('Needs an account')
  const failed = f.store.agentJob(job.id)
  assert.equal(failed.state, 'failed')
  assert.match(failed.summary, /Gemini needs you to sign in\. Run agy in Terminal/)
  assert.deepEqual(transport.written.map(({ method }) => method), ['initialize', 'session/new'])
  assert.equal(transport.sent('authenticate').length, 0)
  assert.ok(transport.closed)
  assert.equal(f.store.task(task.id).status, 'To do', 'The task returns to To do, not to another agent')
  assert.equal(f.launched.length, 1, 'No other agent ran in its place')
})

test('an unavailable model, an incompatible CLI or a CLI without Google sign-in fails closed', async (t) => {
  for (const [replies, pattern, last] of [
    [{ 'session/new': () => ({ sessionId, modes: modes(), models: models(carbon, [carbon]) }) },
      /does not offer gemini-3\.8-flash-high.*did not switch models/, 'session/new'],
    [{ 'session/set_model': () => { throw new Error('quota') } }, /does not offer gemini-3\.8-flash-high/, 'session/set_model'],
    [{ initialize: () => ({ ...initialized, protocolVersion: 2 }) }, /not compatible with OpenTalon/, 'initialize'],
    [{ initialize: () => ({ ...initialized, authMethods: initialized.authMethods.slice(2) }) }, /does not offer Google sign-in/, 'initialize'],
    [{ 'session/new': () => ({ sessionId: '../escape' }) }, /did not return a conversation/, 'session/new'],
    [{ 'session/new': () => ({ sessionId, models: models(), modes: modes('plan', ['plan']) }) }, /approval mode OpenTalon can enforce/, 'session/set_model'],
  ]) {
    const f = fixture(t, replies)
    await f.settings()
    const { job, transport } = await f.send('Fail closed')
    assert.equal(f.store.agentJob(job.id).state, 'failed')
    assert.match(f.store.agentJob(job.id).summary, pattern)
    assert.equal(transport.written.at(-1).method, last)
    assert.equal(transport.sent('session/prompt').length, 0)
    assert.ok(transport.closed)
  }
})

test('a missing agy launcher blocks dispatch and reports Gemini as not installed', async (t) => {
  const f = fixture(t, {}, { installed: false })
  assert.deepEqual(f.runner.status().gemini, { installed: false, name: 'Gemini' })
  assert.throws(() => assertAgentReady({ defaultAgent: 'gemini', workingFolder: f.folder }, f.runner.status(), { running: true }),
    { code: 'AGENT_NOT_INSTALLED' })
  await f.settings()
  const { job } = await f.send('No launcher')
  assert.equal(f.store.agentJob(job.id).state, 'failed')
  assert.match(f.store.agentJob(job.id).summary, /Gemini’s local launcher is not installed/)
  assert.equal(f.launched.length, 0)
})

test('a Google task restricts its own MCP access without changing global servers or saved permissions', (t) => {
  const f = fixture(t)
  const config = path.join(f.folder, '.gemini', 'config')
  const cli = path.join(f.folder, '.gemini', 'antigravity-cli')
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(cli, { recursive: true })
  const registration = JSON.stringify({ mcpServers: { peer: { command: 'peer' }, off: { disabled: true } } })
  const original = JSON.stringify({ permissions: { allow: ['mcp(peer/*)'], ask: ['command(*)'], deny: ['read_file(secrets)'] } })
  fs.writeFileSync(path.join(config, 'mcp_config.json'), registration)
  fs.writeFileSync(path.join(cli, 'settings.json'), original)
  const [flag, session] = gemini.geminiScopedSettings(f.folder, f.folder)
  assert.equal(flag, '--settings')
  assert.deepEqual(JSON.parse(session).permissions, { allow: ['mcp(peer/*)'], ask: ['command(*)'], deny: ['read_file(secrets)', 'mcp(peer/*)'] })
  assert.equal(fs.readFileSync(path.join(cli, 'settings.json'), 'utf8'), original)
  assert.equal(fs.readFileSync(path.join(config, 'mcp_config.json'), 'utf8'), registration)
})

test('tool servers saved in Antigravity stop the run before agy starts', async (t) => {
  const f = fixture(t)
  await f.settings()
  const config = path.join(f.folder, '.gemini', 'config')
  fs.mkdirSync(path.join(config, 'plugins', 'drive'), { recursive: true })
  fs.writeFileSync(path.join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: {
    opentalon: { command: 'old-bridge' }, paused: { command: 'x', disabled: true } } }))
  fs.writeFileSync(path.join(config, 'plugins', 'drive', 'mcp_config.json'), JSON.stringify({ mcpServers: { drive: { url: 'https://example.test' } } }))
  const blocked = await f.send('Scoped only')
  assert.equal(f.store.agentJob(blocked.job.id).state, 'failed')
  assert.match(f.store.agentJob(blocked.job.id).summary, /conflicts with the scoped OpenTalon/)
  assert.equal(f.launched.length, 0)

  fs.rmSync(path.join(f.folder, '.gemini'), { recursive: true })
  fs.mkdirSync(path.join(f.folder, '.agents'))
  fs.writeFileSync(path.join(f.folder, '.agents', 'mcp_config.json'), '{ not json')
  const unreadable = await f.send('Unreadable settings')
  assert.match(f.store.agentJob(unreadable.job.id).summary, /tool server settings could not be read/)
  assert.equal(f.launched.length, 0)

  fs.writeFileSync(path.join(f.folder, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { paused: { command: 'x', disabled: true } } }))
  const allowed = await f.send('Nothing else enabled')
  assert.equal(f.store.agentJob(allowed.job.id).state, 'starting')
  assert.equal(f.launched.length, 1)
})

test('the saved access mode decides the agy flags and session mode', async (t) => {
  const manual = fixture(t, { 'session/new': () => ({ sessionId, models: models(flash), modes: modes('auto') }) })
  await manual.settings('manual')
  const asked = (await manual.send('Manual')).transport
  assert.deepEqual(asked.args, ['acp', '--sandbox'])
  assert.deepEqual(asked.sent('session/set_mode').map(({ params }) => params.modeId), ['default'])
  assert.equal(asked.sent('session/set_model').length, 0, 'The model is already the requested one')

  const full = fixture(t)
  await full.settings('full-access')
  const open = (await full.send('Full access')).transport
  assert.deepEqual(open.args, ['acp', '--dangerously-skip-permissions'])
  assert.equal(open.sent('session/set_mode').length, 0)

  const noAuto = fixture(t, { 'session/new': () => ({ sessionId, models: models(flash), modes: modes('default', ['default', 'plan']) }) })
  await noAuto.settings('auto')
  const fallback = (await noAuto.send('Automatic without auto mode')).transport
  assert.deepEqual(fallback.args, ['acp', '--sandbox'])
  assert.equal(fallback.sent('session/set_mode').length, 0, 'Stays in the mode that asks the owner')
})

test('Gemini approvals reach the owner, answer once with the offered option, and other requests are refused', async (t) => {
  const f = fixture(t)
  await f.settings('manual')
  const { job, transport } = await f.send('Needs approval')
  const options = [
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ]
  const ask = (id, extra = {}) => transport.message({
    id, method: 'session/request_permission',
    params: { sessionId, toolCall: { toolCallId: 'call-' + id, title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } }, options, ...extra },
  })
  await ask(7)
  const waiting = f.store.agentJob(job.id)
  assert.equal(waiting.state, 'needs-input')
  assert.deepEqual([waiting.approval.id, waiting.approval.title, waiting.approval.canApprove], ['7', 'Run npm test', true])
  assert.match(waiting.approval.details, /npm test/)
  await f.runner.answer(job.id, '7', true)
  assert.deepEqual(transport.written.at(-1), { id: 7, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
  assert.equal(f.store.agentJob(job.id).state, 'working')

  await ask(8)
  await f.runner.answer(job.id, '8', false)
  assert.deepEqual(transport.written.at(-1), { id: 8, result: { outcome: { outcome: 'selected', optionId: 'no' } } })

  await ask(9, { options: [options[0]] })
  assert.equal(f.store.agentJob(job.id).approval.canApprove, false, 'A standing grant is never given on the owner’s behalf')
  await assert.rejects(f.runner.answer(job.id, '9', true), { code: 'STALE_APPROVAL' })
  await f.runner.answer(job.id, '9', false)
  assert.deepEqual(transport.written.at(-1), { id: 9, result: { outcome: { outcome: 'cancelled' } } })

  await transport.message({ id: 10, method: 'fs/write_text_file', params: { sessionId, path: '/etc/hosts', content: '' } })
  assert.equal(transport.written.at(-1).error.code, -32601)
  await ask(11, { sessionId: 'another-session' })
  assert.equal(transport.written.at(-1).error.code, -32601)
  assert.equal(f.store.agentJob(job.id).approval, null)
})

test('stopping a Gemini run cancels the turn, then closes agy; late replies change nothing', async (t) => {
  const f = fixture(t)
  await f.settings()
  const { job, transport } = await f.send('Stop me')
  await f.said(transport, 'Working')
  await f.runner.stop(job.id)
  assert.equal(f.store.agentJob(job.id).state, 'canceled')
  assert.deepEqual(transport.written.at(-1), { method: 'session/cancel', params: { sessionId } })
  assert.equal(f.runner.current, null)
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.ok(transport.closed)
  transport.turn.resolve({ stopReason: 'cancelled' })
  await f.said(transport, 'Late text')
  await transport.exit(new Error('Late exit'))
  assert.equal(f.store.agentJob(job.id).state, 'canceled')
})

test('turn endings and a mid-run model switch are terminal, with Gemini named in the reason', async (t) => {
  for (const [result, state, pattern] of [
    [{ stopReason: 'refusal' }, 'failed', /Gemini declined this request/],
    [{ stopReason: 'max_turn_requests' }, 'failed', /stopped before finishing \(max turn requests\)/],
    [{ stopReason: 'cancelled' }, 'canceled', /Gemini stopped this turn/],
    [{}, 'failed', /stopped before finishing\./],
  ]) {
    const f = fixture(t)
    await f.settings()
    const { job, transport } = await f.send('Ends')
    transport.turn.resolve(result)
    await new Promise(setImmediate)
    assert.equal(f.store.agentJob(job.id).state, state)
    assert.match(f.store.agentJob(job.id).summary, pattern)
  }
  const signedOutLater = fixture(t)
  await signedOutLater.settings()
  const expired = await signedOutLater.send('Token expired')
  expired.transport.turn.reject(rejection(signedOut))
  await new Promise(setImmediate)
  assert.match(signedOutLater.store.agentJob(expired.job.id).summary, /Gemini needs you to sign in/)

  const f = fixture(t, { 'session/new': () => ({ sessionId, modes: modes('auto'), configOptions: [
    { id: 'model', category: 'model', currentValue: hydrogen, options: [{ value: hydrogen, name: 'Hydrogen' }, { value: flash, name: 'Flash' }] }] }) })
  await f.settings()
  const { job, transport } = await f.send('Stay on Hydrogen', { agent: 'gemini', model: hydrogen })
  const option = (currentValue) => ({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', category: 'model', currentValue }] })
  await f.update(transport, option(hydrogen))
  assert.equal(f.store.agentJob(job.id).state, 'working')
  await f.update(transport, option(flash))
  assert.equal(f.store.agentJob(job.id).state, 'failed')
  assert.match(f.store.agentJob(job.id).summary, /switched away from gemini-4-hydrogen-high/)
})

test('a Gemini run continues the same conversation, ignores replayed history, and refuses a different one', async (t) => {
  const f = fixture(t)
  await f.settings()
  const { task, job, transport } = await f.send('Continue me')
  await f.said(transport, 'Which fixture?')
  await f.write('report_agent_progress', { runId: job.id, state: 'needs-input', summary: 'Which fixture should I use?' })
  transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  const read = await f.store.dispatch('get_task_agent_run', { taskId: task.id })
  assert.equal(read.run.state, 'waiting-input')
  assert.equal(read.run.threadId, sessionId)
  const recovered = await f.write('recover_agent_run', {
    taskId: task.id, expectedRunId: job.id, expectedRevision: read.task.revision, mode: 'queue', message: 'Use the local fixture.',
  })
  await f.runner.tick()
  const resumed = f.launched[1]
  assert.deepEqual(resumed.written.map(({ method }) => method),
    ['initialize', 'session/resume', 'session/set_model', 'session/set_mode', 'session/prompt'])
  assert.equal(resumed.sent('session/resume')[0].params.sessionId, sessionId)
  assert.equal(resumed.sent('session/resume')[0].params.mcpServers[0].name, 'opentalon')
  assert.equal(resumed.cwd, job.workingFolder)
  assert.equal(resumed.sent('session/set_model')[0].params.modelId, flash, 'The continuation keeps the run’s model')
  assert.match(resumed.sent('session/prompt')[0].params.prompt[0].text, /Use the local fixture/)
  assert.equal(f.store.agentJob(recovered.run.id).threadId, sessionId)
  await f.runner.stop(recovered.run.id)

  const replay = fixture(t, {
    initialize: () => ({ ...initialized, agentCapabilities: { loadSession: true, promptCapabilities: {} } }),
    'session/load': async (params, entry) => {
      await entry.message({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old reply' } } } })
      return { modes: modes(), models: models() }
    },
  })
  await replay.settings()
  const first = await replay.send('Replay')
  first.transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  await replay.write('move_task', { id: first.task.id, expectedRevision: replay.store.task(first.task.id).revision, status: 'In progress' }).catch(() => {})
  const again = replay.store.agentJob(first.job.id)
  replay.store.saveAgentJob({ ...again, id: randomUUID(), state: 'queued', resumeThread: true, threadId: sessionId, pickedUpAt: undefined })
  const queued = replay.store.agentJobs().find((entry) => entry.state === 'queued')
  replay.store.assignAgent(first.task.id, queued.id)
  await replay.runner.tick()
  const loaded = replay.launched[1]
  assert.ok(loaded.sent('session/load').length === 1 && loaded.sent('session/resume').length === 0)
  assert.equal(replay.store.agentJob(queued.id).state, 'starting', 'Replayed history is not a pickup')
  assert.equal(replay.runner.current.lastText, '')
  await replay.runner.stop(queued.id)

  for (const [replies, pattern] of [
    [{ 'session/resume': () => ({ sessionId: 'someone-else' }) }, /did not resume the original conversation/],
    [{ initialize: () => ({ ...initialized, agentCapabilities: {} }) }, /cannot reopen a saved conversation/],
  ]) {
    const wrong = fixture(t, replies)
    await wrong.settings()
    const { task: other } = await wrong.write('create_task', { boardId: wrong.store.boards()[0].id, title: 'Wrong thread', status: 'In progress' })
    const stale = wrong.store.saveAgentJob({
      id: randomUUID(), taskId: other.id, agent: 'gemini', model: hydrogen, workingFolder: wrong.folder,
      state: 'queued', resumeThread: true, threadId: sessionId, summary: 'Waiting', createdAt: new Date().toISOString(),
    })
    wrong.store.assignAgent(other.id, stale.id)
    await wrong.runner.tick()
    assert.equal(wrong.store.agentJob(stale.id).state, 'failed')
    assert.match(wrong.store.agentJob(stale.id).summary, pattern)
    assert.equal(wrong.launched[0].sent('session/prompt').length, 0)
  }
})

test('Gemini conversations are not opened in another app', async (t) => {
  const f = fixture(t)
  await f.settings()
  const { job, transport } = await f.send('Stay here')
  transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  await assert.rejects(f.runner.openThread(job.id), { code: 'THREAD_OPEN_UNSUPPORTED' })
  assert.deepEqual(f.opened, [])
})

test('revision screenshots go to Gemini as images only when agy accepts them', () => {
  const images = [{ data: 'AAAA', mimeType: 'image/png', name: 'shot.png' }]
  assert.deepEqual(gemini.geminiPrompt('Fix it', images, initialized.agentCapabilities), [
    { type: 'text', text: 'Fix it' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ])
  assert.deepEqual(gemini.geminiPrompt('Fix it', images, {}), [{ type: 'text', text: 'Fix it' }])
})

test('Gemini settings, runs and comments survive JSON and SQLite backups', async (t) => {
  const f = fixture(t)
  await f.settings('manual')
  const { job, transport } = await f.send('Back me up', { model: carbon, agent: 'gemini' })
  transport.turn.resolve({ stopReason: 'end_turn' })
  await new Promise(setImmediate)
  for (const format of ['json', 'sqlite']) {
    const backup = await f.write('create_backup', { format })
    const inspected = await f.store.dispatch('inspect_backup', { path: backup.path })
    assert.equal(inspected.tasks, 1)
    const folder = fs.mkdtempSync(path.join(base, 'gemini-restore-'))
    const target = new Store(folder)
    t.after(() => { target.close(); fs.rmSync(folder, { recursive: true, force: true }) })
    const preview = await target.dispatch('preview_destructive_action', { action: 'restore_backup', path: backup.path })
    await target.dispatch('confirm_destructive_action', { token: preview.token, requestKey: randomUUID() })
    assert.equal(target.agentSettings().defaultAgent, 'gemini')
    assert.equal(target.agentSettings().permissionMode, 'manual')
    const restored = target.agentJob(job.id)
    assert.deepEqual([restored.agent, restored.model, restored.threadId], ['gemini', carbon, sessionId])
  }
  const exported = await f.write('create_backup', { format: 'json' })
  const tampered = path.join(f.folder, 'tampered.json')
  fs.writeFileSync(tampered, fs.readFileSync(exported.path, 'utf8').replace(/"defaultAgent":\s*"gemini"/, '"defaultAgent":"bard"'))
  await assert.rejects(f.store.dispatch('inspect_backup', { path: tampered }), { code: 'INVALID_BACKUP' })
})

// The remaining tests run a real child process through the production transport.
function fakeAgyBinary(t, script) {
  const folder = fs.mkdtempSync(path.join(base, 'gemini-agy-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'agy')
  const log = path.join(folder, 'calls.jsonl')
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs')
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n')
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(
  ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_GEMINI_BASE_URL', 'ELECTRON_RUN_AS_NODE'].map((key) => [key, process.env[key] ?? null])) })
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
${script}
`, { mode: 0o755 })
  return { folder, file, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }
}
const acpServer = (sessionNew) => `
const initialized = ${JSON.stringify(initialized)}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  log({ line: message })
  if (message.method === 'initialize') send({ id: message.id, result: initialized })
  else if (message.method === 'session/new') ${sessionNew}
  else if (message.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Created VOX-001.' } } } })
    send({ id: message.id, result: { stopReason: 'end_turn' } })
  } else if (message.id !== undefined) send({ id: message.id, result: {} })
})`
const sessionReply = `send({ id: message.id, result: { sessionId: 's-1', modes: ${JSON.stringify(modes())}, models: ${JSON.stringify(models())} } })`
const chatConfig = { command: '/safe/node', args: ['/chat-bridge.cjs'], env: { OPENTALON_MCP_CONFIG: '/chat/config.json', OPENTALON_MCP_NO_LAUNCH: '1' } }

test('Ask my agent talks to a real agy process: JSON-RPC lines, model, scoped server, clean environment', async (t) => {
  const agy = fakeAgyBinary(t, acpServer(sessionReply))
  for (const key of gemini.unsupportedAuthEnvironment) process.env[key] = 'leak'
  t.after(() => { for (const key of gemini.unsupportedAuthEnvironment) delete process.env[key] })
  const reply = await askAgent('gemini', {
    resolveExecutable: () => agy.file, home: agy.folder, workingFolder: agy.folder, config: chatConfig, model: hydrogen,
    message: 'Add a task', history: [], project: 'Voxa', permissionMode: 'auto',
  })
  assert.deepEqual(reply, { text: 'Created VOX-001.' })
  const [start, ...lines] = agy.calls()
  assert.deepEqual(start.argv, ['acp', '--sandbox'])
  assert.equal(start.cwd, fs.realpathSync(agy.folder))
  assert.deepEqual(start.env, { GEMINI_API_KEY: null, AGY_ADC_AUTH: null, GOOGLE_GEMINI_BASE_URL: null, ELECTRON_RUN_AS_NODE: null })
  const sent = lines.map(({ line }) => line)
  assert.ok(sent.every((line) => line.jsonrpc === '2.0'))
  assert.deepEqual(sent.map(({ method }) => method),
    ['initialize', 'session/new', 'session/set_model', 'session/set_mode', 'session/prompt'])
  assert.deepEqual(sent[1].params.mcpServers, [{
    name: 'opentalon', command: '/safe/node', args: ['/chat-bridge.cjs'],
    env: [{ name: 'OPENTALON_MCP_CONFIG', value: '/chat/config.json' }, { name: 'OPENTALON_MCP_NO_LAUNCH', value: '1' }],
  }])
  assert.deepEqual(sent[2].params, { sessionId: 's-1', modelId: hydrogen })
  assert.match(sent[4].params.prompt[0].text, /"latestMessage":"Add a task"/)
})

test('Ask my agent fails closed for a signed-out agy, a missing model, a declined approval and a missing launcher', async (t) => {
  const options = (file, extra = {}) => ({
    resolveExecutable: () => file, home: path.dirname(file ?? base), workingFolder: path.dirname(file ?? base),
    config: chatConfig, model: hydrogen, message: 'Hi', history: [], ...extra,
  })
  const signedOutAgy = fakeAgyBinary(t, acpServer(`send({ id: message.id, error: ${JSON.stringify(signedOut)} })`))
  await assert.rejects(askAgent('gemini', options(signedOutAgy.file)), (error) =>
    error.code === 'CHAT_AUTH_REQUIRED' && /Gemini needs you to sign in again\. Run agy in Terminal/.test(error.message))
  assert.ok(!signedOutAgy.calls().some(({ line }) => ['authenticate', 'session/prompt'].includes(line?.method)))

  const ready = fakeAgyBinary(t, acpServer(sessionReply))
  await assert.rejects(askAgent('gemini', options(ready.file, { model: undefined })), { code: 'AGENT_MODEL_REQUIRED' })
  await assert.rejects(askAgent('gemini', options(ready.file, { model: 'gemini-4-argon-high' })), { code: 'AGENT_MODEL_UNAVAILABLE' })
  await assert.rejects(askAgent('gemini', options(null)), { code: 'AGENT_MISSING' })

  const asks = fakeAgyBinary(t, acpServer(sessionReply).replace(
    "send({ id: message.id, result: { stopReason: 'end_turn' } })",
    `send({ id: 'p1', method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 'c1', title: 'Run rm' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } })
    pending = message.id`).replace("log({ line: message })", `log({ line: message })
  if (message.id === 'p1') return send({ id: pending, result: { stopReason: 'end_turn' } })`).replace('const initialized', 'let pending\nconst initialized'))
  await assert.rejects(askAgent('gemini', options(asks.file, { permissionMode: 'manual' })), { code: 'CHAT_PERMISSION_REQUIRED' })
  const answer = asks.calls().find(({ line }) => line?.id === 'p1').line
  assert.deepEqual(answer.result, { outcome: { outcome: 'selected', optionId: 'n' } })

  const full = fakeAgyBinary(t, acpServer(sessionReply))
  await askAgent('gemini', options(full.file, { permissionMode: 'full-access' }))
  assert.deepEqual(full.calls()[0].argv, ['acp', '--dangerously-skip-permissions'])
  assert.ok(!full.calls().some(({ line }) => line?.method === 'session/set_mode'))
})

test('the production transport ends a turn request when agy exits and frames requests as JSON-RPC', async (t) => {
  const agy = fakeAgyBinary(t, `
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  log({ line: message })
  if (message.method === 'initialize') send({ id: message.id, result: ${JSON.stringify(initialized)} })
  else process.exit(3)
})`)
  const exits = []
  const transport = new JsonProcess(agy.file, ['acp', '--sandbox'], agy.folder, () => {}, (error) => exits.push(error.message), gemini.transportOptions)
  assert.equal((await gemini.geminiInitialize(transport)).loadSession, true)
  await assert.rejects(transport.request('session/prompt', { sessionId: 's-1', prompt: [] }, false, 0), /agent process ended \(exit 3\)/)
  assert.equal(exits.length, 1)
  assert.deepEqual(agy.calls().slice(1).map(({ line }) => [line.jsonrpc, line.method]), [['2.0', 'initialize'], ['2.0', 'session/prompt']])
})

test('Gemini drafting runs agy print mode with the named model in read-only plan mode', async (t) => {
  const envelope = (body) => `process.stdout.write(JSON.stringify(${JSON.stringify(body)}))`
  const draft = { title: 'Ship notes', notes: 'Write them', definitionOfDone: 'Published', project: 1, newProjectName: '', priority: 'High' }
  const agy = fakeAgyBinary(t, envelope({ conversation_id: 'c-1', status: 'SUCCESS', response: '', structured_output: draft }))
  process.env.GEMINI_API_KEY = 'leak'
  t.after(() => delete process.env.GEMINI_API_KEY)
  const options = (file, extra = {}) => ({
    resolveExecutable: () => file, home: path.dirname(file), workingFolder: path.dirname(file), model: hydrogen,
    projects: [{ id: 'board-1', name: 'Voxa' }], priorities: ['High', 'None'], ...extra,
  })
  const result = await draftTask('gemini', 'Ship the release notes for Voxa', options(agy.file, { permissionMode: 'full-access' }))
  assert.deepEqual([result.title, result.projectId, result.priority], ['Ship notes', 'board-1', 'High'])
  const { argv, env, cwd } = agy.calls()[0]
  assert.equal(cwd, fs.realpathSync(agy.folder))
  assert.equal(env.GEMINI_API_KEY, null)
  const value = (flag) => argv[argv.indexOf(flag) + 1]
  assert.deepEqual([value('--model'), value('--mode'), value('--output-format'), value('--print-timeout')], [hydrogen, 'plan', 'json', '40s'])
  assert.ok(argv.includes('--sandbox') && argv.includes('--disable-slash-commands'))
  assert.ok(!argv.includes('--dangerously-skip-permissions'), 'Drafting never needs more than read-only access')
  assert.deepEqual(JSON.parse(value('--json-schema')).required, ['title', 'notes', 'definitionOfDone', 'project', 'newProjectName', 'priority'])
  assert.match(value('--print'), /Ship the release notes for Voxa/)
  assert.equal(argv.at(-2), '--print')

  // The envelope and exit code agy 1.5.15 really prints when nobody is signed in.
  const signedOutAgy = fakeAgyBinary(t, envelope(captured('print-signed-out')) + '; process.exitCode = 1')
  await assert.rejects(draftTask('gemini', 'Idea', options(signedOutAgy.file)), { code: 'AGENT_AUTH_REQUIRED' })
  const wrongModel = fakeAgyBinary(t, envelope({ status: 'ERROR', error: 'invalid model selection (--model gemini-4-hydrogen-high). Available models: gemini-3.8-flash-high' }) + '; process.exitCode = 1')
  await assert.rejects(draftTask('gemini', 'Idea', options(wrongModel.file)), { code: 'DRAFT_FAILED', message: 'Gemini couldn’t draft task details.' })
  await assert.rejects(draftTask('gemini', 'Idea', options(agy.file, { model: undefined })), { code: 'AGENT_MODEL_REQUIRED' })
  fs.mkdirSync(path.join(agy.folder, '.agents'))
  fs.writeFileSync(path.join(agy.folder, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }))
  await draftTask('gemini', 'Idea', options(agy.file))
  const latest = agy.calls().at(-1)
  assert.ok(JSON.stringify(latest).includes('mcp('))
})

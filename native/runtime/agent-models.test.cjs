const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Store, FORMAT } = require('./store.cjs')
const { agentModels, mergeAgentModels, validateModelOverrides } = require('./agent-models.cjs')
const { tools } = require('./contracts.cjs')
const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })
const write = (store, name, args = {}) => store.dispatch(name, { ...args, requestKey: randomUUID() })

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(base, 'models-'))
  const store = new Store(folder)
  t.after(() => { store.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  return { store, folder }
}

test('current shipped models include verified current provider IDs and omit superseded Sol/Astra', () => {
  assert.ok(agentModels.some(x => x.agent === 'codex' && x.id === 'gpt-6.2-sol'))
  assert.ok(agentModels.some(x => x.agent === 'codex' && x.id === 'gpt-6.2-astra'))
  assert.ok(agentModels.some(x => x.agent === 'claude-code' && x.id === 'claude-fable-5-2'))
  assert.ok(agentModels.some(x => x.agent === 'claude-code' && x.id === 'claude-haiku-5-5'))
  assert.ok(!agentModels.some(x => ['gpt-6-astra', 'gpt-6.1-sol'].includes(x.id)))
  assert.ok(tools.some(x => x.name === 'get_agent_models' && !x.mutates))
  assert.ok(tools.some(x => x.name === 'set_agent_models' && x.mutates))
})

test('a later app default catalog adds new models while preserving custom labels, hidden choices and custom models', () => {
  const old = [
    { agent: 'codex', id: 'old-default', title: 'Old default' },
    { agent: 'codex', id: 'kept', title: 'Original name' },
    { agent: 'claude-code', id: 'hidden', title: 'Hidden choice' },
  ]
  const overrides = validateModelOverrides([
    { agent: 'codex', id: 'kept', title: 'My name' },
    { agent: 'claude-code', id: 'hidden', title: 'Hidden choice', hidden: true },
    { agent: 'codex', id: 'custom-next', title: 'My custom model' },
  ])
  const next = [old[1], old[2], { agent: 'codex', id: 'new-default', title: 'New default' }]
  assert.deepEqual(mergeAgentModels(next, overrides), [
    { agent: 'codex', id: 'kept', title: 'My name' },
    { agent: 'codex', id: 'new-default', title: 'New default' },
    { agent: 'codex', id: 'custom-next', title: 'My custom model' },
  ])
  assert.equal(old[1].title, 'Original name', 'Merging must not mutate shipped defaults')
})

test('catalog edits are independently versioned, replay-safe and never dispatch or rewrite tasks', async t => {
  const { store } = fixture(t)
  const first = await store.dispatch('get_agent_models')
  const task = (await write(store, 'create_task', { boardId: store.boards()[0].id, title: 'Keep this unchanged' })).task
  const overrides = [{ agent: 'codex', id: 'provider-new-model', title: ' My model ' }]
  const args = { overrides, expectedCatalogRevision: first.catalogRevision, requestKey: randomUUID() }
  const saved = await store.dispatch('set_agent_models', args)
  assert.equal(saved.catalogRevision, first.catalogRevision + 1)
  assert.equal(saved.models.at(-1).title, 'My model')
  assert.deepEqual(await store.dispatch('set_agent_models', args), saved)
  await assert.rejects(write(store, 'set_agent_models', { overrides: [], expectedCatalogRevision: first.catalogRevision }), { code: 'CONFLICT' })
  assert.equal(store.task(task.id).revision, task.revision)
  assert.equal(store.task(task.id).status, 'To do')
  assert.deepEqual(store.agentJobs(), [])
  const reset = await write(store, 'set_agent_models', { overrides: [], expectedCatalogRevision: saved.catalogRevision })
  assert.deepEqual(reset.models, agentModels)
})

test('invalid catalog writes are atomic and cannot smuggle flags or duplicate models', async t => {
  const { store } = fixture(t)
  const before = await store.dispatch('get_agent_models')
  for (const overrides of [
    [{ agent: 'codex', id: '--config', title: 'Bad flag' }],
    [{ agent: 'codex', id: 'good', title: '  ' }],
    [{ agent: 'codex', id: 'good', title: 'Bad\nname' }],
    [{ agent: 'another-provider', id: 'good', title: 'Bad provider' }],
    [{ agent: 'codex', id: 'good', title: 'One' }, { agent: 'codex', id: 'good', title: 'Two' }],
  ]) {
    await assert.rejects(write(store, 'set_agent_models', { overrides, expectedCatalogRevision: before.catalogRevision }), { code: 'INVALID_ARGUMENT' })
  }
  assert.deepEqual(await store.dispatch('get_agent_models'), before)
})

test('custom models are validated for the chosen provider and stored unchanged on the dispatched run', async t => {
  const { store, folder } = fixture(t)
  await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder })
  const current = await store.dispatch('get_agent_models')
  const overrides = [{ agent: 'codex', id: 'my-custom-model', title: 'Custom' }]
  await write(store, 'set_agent_models', { overrides, expectedCatalogRevision: current.catalogRevision })
  const task = (await write(store, 'create_task', { boardId: store.boards()[0].id, title: 'Use my model', status: 'Sent to agent', agent: 'codex', model: 'my-custom-model' })).task
  const run = store.agentJobs()[0]
  assert.equal(run.model, 'my-custom-model')
  const catalog = await store.dispatch('get_agent_models')
  await write(store, 'set_agent_models', { overrides: [], expectedCatalogRevision: catalog.catalogRevision })
  assert.equal(store.agentJobs()[0].model, run.model)
  assert.equal(store.task(task.id).status, 'Sent to agent')
  await assert.rejects(write(store, 'create_task', { boardId: store.boards()[0].id, title: 'Wrong provider', status: 'Sent to agent', agent: 'claude-code', model: 'my-custom-model' }), { code: 'INVALID_ARGUMENT' })
})

test('model overrides survive restart and both backup formats; old backups adopt the current defaults', async t => {
  const { store, folder } = fixture(t)
  const overrides = [
    { agent: 'codex', id: 'gpt-6.2-sol', title: 'My Sol' },
    { agent: 'claude-code', id: 'claude-haiku-5-5', title: 'Haiku', hidden: true },
    { agent: 'codex', id: 'next-custom', title: 'Next custom' },
  ]
  await write(store, 'set_agent_models', { overrides, expectedCatalogRevision: 1 })
  const expected = (await store.dispatch('get_agent_models')).models
  await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder })
  await write(store, 'create_task', { boardId: store.boards()[0].id, title: 'History keeps my selected model',
    status: 'Sent to agent', agent: 'codex', model: 'next-custom' })
  const reopened = new Store(folder)
  assert.deepEqual(reopened.agentModelCatalog().models, expected)
  reopened.close()
  for (const format of ['json', 'sqlite']) {
    const backup = await write(store, 'create_backup', { format })
    const target = new Store(path.join(folder, 'restore-' + format))
    try {
      const preview = await target.dispatch('preview_destructive_action', { action: 'restore_backup', path: backup.path })
      await write(target, 'confirm_destructive_action', { token: preview.token })
      assert.deepEqual(target.agentModelCatalog().models, expected)
      assert.equal(target.agentJobs()[0].model, 'next-custom')
    } finally { target.close() }
  }
  const exported = await write(store, 'create_backup', { format: 'json' })
  const payload = JSON.parse(fs.readFileSync(exported.path))
  payload.formatVersion = 12
  delete payload.agentModelOverrides
  const old = path.join(folder, 'old-backup.json')
  fs.writeFileSync(old, JSON.stringify(payload))
  const preview = await store.dispatch('preview_destructive_action', { action: 'restore_backup', path: old })
  await write(store, 'confirm_destructive_action', { token: preview.token })
  assert.deepEqual(store.agentModelCatalog().models, agentModels)
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, FORMAT)
})

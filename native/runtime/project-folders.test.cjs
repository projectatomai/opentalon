const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Store } = require('./store.cjs')
const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })
const write = (store, name, args) => store.dispatch(name, { ...args, requestKey: randomUUID() })

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(base, 'project-folders-'))
  const store = new Store(folder)
  t.after(() => { store.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  const custom = path.join(folder, 'Project work')
  fs.mkdirSync(custom)
  return { store, folder, custom, board: store.boards()[0] }
}

test('projects inherit global folder and can independently override or reset it with conflict protection', async t => {
  const { store, folder, custom, board } = fixture(t)
  await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder })
  assert.equal(store.projectFolder(board.id).effectiveFolder, folder)
  assert.equal(store.projectFolder(board.id).workingFolder, '')
  const other = (await write(store, 'create_board', { name: 'Other project' })).board
  const args = { requestKey: randomUUID(), id: board.id, expectedRevision: board.revision, workingFolder: custom }
  const saved = await store.dispatch('set_project_folder', args)
  assert.deepEqual(await store.dispatch('set_project_folder', args), saved)
  assert.equal(saved.effectiveFolder, fs.realpathSync(custom))
  assert.equal(store.projectFolder(other.id).effectiveFolder, folder)
  assert.equal(store.agentSettings().workingFolder, folder)
  await assert.rejects(write(store, 'set_project_folder', { ...args, expectedRevision: board.revision }), { code: 'CONFLICT' })
  for (const invalid of ['relative/folder', path.join(folder, 'not-present')]) {
    await assert.rejects(write(store, 'set_project_folder', { id: board.id, expectedRevision: saved.revision, workingFolder: invalid }), { code: 'INVALID_ARGUMENT' })
    assert.equal(store.projectFolder(board.id).workingFolder, fs.realpathSync(custom))
  }
  const task = (await write(store, 'create_task', { boardId: board.id, title: 'Phone dispatch uses this project' })).task
  await write(store, 'companion_set_task_field', { id: task.id, field: 'status', expectedValue: 'To do', value: 'Sent to agent', agent: 'codex' })
  assert.equal(store.agentJobs()[0].workingFolder, fs.realpathSync(custom))
  const reset = await write(store, 'set_project_folder', { id: board.id, expectedRevision: saved.revision, workingFolder: '' })
  assert.equal(reset.effectiveFolder, folder)
  assert.equal(store.agentJobs()[0].workingFolder, fs.realpathSync(custom), 'A queued conversation retains its selected folder')
  assert.equal(store.task(task.id).status, 'Sent to agent')
})

test('project folders survive restart and backups; unavailable restored folders do not silently use global', async t => {
  const { store, folder, custom, board } = fixture(t)
  await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder })
  await write(store, 'set_project_folder', { id: board.id, expectedRevision: board.revision, workingFolder: custom })
  const reopened = new Store(folder)
  assert.equal(reopened.projectFolder(board.id).workingFolder, fs.realpathSync(custom))
  reopened.close()
  for (const format of ['json', 'sqlite']) {
    const backup = await write(store, 'create_backup', { format })
    const target = new Store(path.join(folder, 'restore-' + format))
    try {
      const preview = await target.dispatch('preview_destructive_action', { action: 'restore_backup', path: backup.path })
      await write(target, 'confirm_destructive_action', { token: preview.token })
      assert.equal(target.agentSettings(board.id).workingFolder, fs.realpathSync(custom))
    } finally { target.close() }
  }
  fs.rmdirSync(custom)
  assert.equal(store.agentSettings(board.id).workingFolder, custom)
  const backup = await write(store, 'create_backup', { format: 'json' })
  const payload = JSON.parse(fs.readFileSync(backup.path))
  payload.projectFolders = { 'unknown-project': folder }
  const invalid = path.join(folder, 'invalid-folders.json')
  fs.writeFileSync(invalid, JSON.stringify(payload))
  await assert.rejects(store.dispatch('inspect_backup', { path: invalid }), { code: 'INVALID_BACKUP' })
  assert.equal(store.projectFolder(board.id).workingFolder, custom)
})

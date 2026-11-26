const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Store } = require('./store.cjs')
const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })
const write = (store, name, input) => store.dispatch(name, { requestKey: randomUUID(), ...input })

test('new setups stay Automatic and saved permission choices survive edits, restart and both backups', async t => {
  const folder = fs.mkdtempSync(path.join(base, 'permissions-'))
  let store = new Store(folder)
  t.after(() => { store.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  assert.equal(store.agentSettings().permissionMode, 'auto')
  await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder })
  assert.equal(store.agentSettings().permissionMode, 'auto')
  for (const mode of ['manual', 'auto', 'full-access']) {
    await write(store, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder, permissionMode: mode })
    await write(store, 'set_agent_settings', { defaultAgent: 'claude-code', workingFolder: folder })
    assert.equal(store.agentSettings().permissionMode, mode)
    store.close()
    store = new Store(folder)
    assert.equal(store.agentSettings().permissionMode, mode)
    for (const format of ['json', 'sqlite']) {
      const backup = await write(store, 'create_backup', { format })
      const restored = new Store(path.join(folder, 'restore-' + mode + '-' + format))
      try {
        await write(restored, 'set_agent_settings', { defaultAgent: 'codex', workingFolder: folder, permissionMode: mode === 'manual' ? 'full-access' : 'manual' })
        const preview = await restored.dispatch('preview_destructive_action', { action: 'restore_backup', path: backup.path })
        await write(restored, 'confirm_destructive_action', { token: preview.token })
        assert.equal(restored.agentSettings().permissionMode, mode)
      } finally { restored.close() }
    }
  }
  const backup = await write(store, 'create_backup', { format: 'json' })
  const payload = JSON.parse(fs.readFileSync(backup.path))
  payload.agentSettings.permissionMode = 'invalid-mode'
  const bad = path.join(folder, 'invalid-permission.json')
  fs.writeFileSync(bad, JSON.stringify(payload))
  await assert.rejects(store.dispatch('inspect_backup', { path: bad }), { code: 'INVALID_BACKUP' })
  assert.equal(store.agentSettings().permissionMode, 'full-access')
})

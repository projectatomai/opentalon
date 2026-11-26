const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Store } = require('./store.cjs')
const { Connector } = require('./mcp.cjs')
const { forward } = require('./mcp-bridge.cjs')
function fixture(t) {
  const root = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
  fs.mkdirSync(root, { recursive: true })
  const folder = fs.mkdtempSync(path.join(root, 'activity-'))
  let store = new Store(folder)
  const cleanup = []
  t.after(async () => {
    for (const close of cleanup) await close()
    store.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const write = (name, input = {}) =>
    store.dispatch(name, { requestKey: randomUUID(), ...input }, 'You · test')
  return {
    folder,
    cleanup,
    get store() {
      return store
    },
    write,
    reopen() {
      store.close()
      store = new Store(folder)
    }
  }
}
const png = {
  name: 'proof.png',
  mimeType: 'image/png',
  data: fs
    .readFileSync(path.join(__dirname, '../assets/opentalon-logo-1024.png'))
    .toString('base64')
}
const activity = (f, id, extra = {}) =>
  f.store.dispatch('list_task_activity', { taskId: id, limit: 50, ...extra })
async function connect(f) {
  const connector = new Connector({
    folder: f.folder,
    call: (name, args) => f.store.dispatch(name, args)
  })
  await connector.enable(true)
  f.cleanup.push(() => connector.stop())
  return async (name, args) => (await forward({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args }
  }, connector.file)).result
}
test('public MCP reports and legacy comment calls write Activity; only the private UI writes Comments', async (t) => {
  const f = fixture(t)
  const { task } = await f.write('create_task', {
    boardId: f.store.boards()[0].id,
    title: 'Verify Activity'
  })
  const rpc = await connect(f)
  const runId = randomUUID()
  f.store.assignAgent(task.id, runId)
  const cases = [
    ['add_task_comment', 'task key', task.taskKey],
    ['add_task_comment', 'UUID', task.id],
    ['add_task_activity', 'task key', task.taskKey.toLowerCase()],
    ['add_task_activity', 'UUID', task.id]
  ]
  for (const [name, form, taskId] of cases) {
    await t.test(`${name} with ${form}`, async () => {
      const input = { taskId, text: 'Agent verification passed', requestKey: randomUUID() }
      if (name === 'add_task_comment') input.notifyAgent = true
      const result = await rpc(name, input)
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
      assert.equal(result.structuredContent.activity.taskId, task.id)
      assert.equal(result.structuredContent.activity.runId, runId)
      assert.deepEqual(await rpc(name, input), result)
      if (name === 'add_task_comment') {
        assert.equal(result.structuredContent.redirectedToActivity, true)
        assert.deepEqual(result.structuredContent.comment, result.structuredContent.activity)
      }
    })
  }
  const input = {
    taskId: task.id,
    text: 'Agent verification passed',
    images: [png],
    requestKey: randomUUID()
  }
  const result = await rpc('add_task_activity', input)
  assert.notEqual(result.isError, true)
  assert.deepEqual(await rpc('add_task_activity', input), result)
  const hidden = await rpc('add_user_comment', {
    taskId: task.id,
    text: 'Should be rejected',
    requestKey: randomUUID()
  })
  assert.equal(hidden.isError, true)
  assert.equal(f.store.comments(task.id).length, 0)
  assert.equal(f.store.task(task.id).commentCount, 0)
  assert.equal(f.store.agentJobs().length, 0)
  const image = result.structuredContent.activity.images[0]
  assert.equal((await f.store.dispatch('read_comment_image', { imageId: image.id })).data, png.data)
  await f.write('add_user_comment', {
    taskId: task.id,
    text: 'Please check the Mac build too.',
    notifyAgent: false
  })
  assert.deepEqual(
    f.store.comments(task.id).map((c) => c.text),
    ['Please check the Mac build too.']
  )
  const entries = (await activity(f, task.id)).entries
  assert.equal(entries.filter((e) => e.kind === 'agent').length, 5)
  assert.equal(entries[0].summary, 'Saved a revision request')
  assert.equal(entries[0].detail, '')
  assert.equal(entries[0].actor, 'You · test')
  await assert.rejects(
    f.store.dispatch('move_task', {
      id: task.id,
      expectedRevision: f.store.task(task.id).revision,
      status: 'Sent to agent',
      dispatchComment: 'Pretend user comment',
      requestKey: randomUUID()
    }),
    { code: 'INVALID_ARGUMENT' }
  )
  const trashed = await rpc('trash_task', { id: task.id, expectedRevision: task.revision, requestKey: randomUUID() })
  assert.equal(trashed.structuredContent.task.deleted, true)
})
test('MCP identifies a foreign-key failure and a retry with the same requestKey saves exactly once', async (t) => {
  const f = fixture(t)
  const { task } = await f.write('create_task', { boardId: f.store.boards()[0].id, title: 'Verify rollback' })
  const rpc = await connect(f)
  const input = { taskId: task.taskKey, text: 'Recovered Activity write', requestKey: randomUUID() }
  const before = (await rpc('list_task_activity', { taskId: task.taskKey })).structuredContent
  // Fail after the report, history and revision have been written, but before commit.
  f.store.db.exec(`
    CREATE TABLE invalid_receipt (task_id TEXT REFERENCES tasks(id));
    CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON operation_receipts BEGIN
      INSERT INTO invalid_receipt VALUES ('missing-task');
    END;
  `)
  const failed = await rpc('add_task_activity', input)
  assert.equal(failed.isError, true)
  assert.equal(failed.structuredContent.code, 'ERR_SQLITE_ERROR')
  assert.match(failed.structuredContent.message, /SQLITE_CONSTRAINT_FOREIGNKEY \(787\).*same requestKey/)
  assert.deepEqual(failed.structuredContent.details, {
    sqliteCode: 'SQLITE_CONSTRAINT_FOREIGNKEY', sqliteResultCode: 787, sameRequestKeySafe: true
  })
  assert.deepEqual(JSON.parse(failed.content[0].text), failed.structuredContent)
  assert.deepEqual((await rpc('list_task_activity', { taskId: task.taskKey })).structuredContent, before)

  f.store.db.exec('DROP TRIGGER reject_receipt')
  const recovered = await rpc('add_task_activity', input)
  assert.equal(recovered.structuredContent.revision, before.revision + 1)
  assert.deepEqual(await rpc('add_task_activity', input), recovered)
  const after = (await rpc('list_task_activity', { taskId: task.taskKey })).structuredContent
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.entries.filter(({ text }) => text === input.text).length, 1)
  assert.equal((await rpc('trash_task', {
    id: task.id, expectedRevision: task.revision, requestKey: randomUUID()
  })).structuredContent.task.deleted, true)
})
test('MCP reports an unavailable backup destination and the next Activity write succeeds', async (t) => {
  const f = fixture(t)
  const { task } = await f.write('create_task', { boardId: f.store.boards()[0].id, title: 'Verify backup isolation' })
  const rpc = await connect(f)
  const [backup, report] = await Promise.all([
    rpc('create_backup', { destination: path.join(f.folder, 'missing-folder', 'snapshot.json'),
      format: 'json', requestKey: randomUUID() }),
    rpc('add_task_activity', { taskId: task.taskKey, text: 'Activity during backup', requestKey: randomUUID() })
  ])
  assert.equal(backup.isError, true)
  assert.equal(backup.structuredContent.code, 'ENOENT')
  assert.match(backup.structuredContent.message, /backup destination is unavailable/)
  assert.equal(report.structuredContent.activity.taskId, task.id)
  assert.equal((await rpc('trash_task', {
    id: task.id, expectedRevision: task.revision, requestKey: randomUUID()
  })).structuredContent.task.deleted, true)
})
test('edits, moves, order, agent pickup and lifecycle changes persist in paginated activity and both backups', async (t) => {
  const f = fixture(t),
    { task } = await f.write('create_task', { boardId: f.store.boards()[0].id, title: 'Original' })
  for (let n = 0; n < 24; n++)
    await f.write('update_task', {
      id: task.id,
      expectedRevision: f.store.task(task.id).revision,
      title: 'Edit ' + n
    })
  const first = await activity(f, task.id, { limit: 10 }),
    older = await activity(f, task.id, { limit: 50, beforeSequence: first.nextBefore })
  assert.equal(first.entries.length, 10)
  assert.equal(older.entries.length, 15)
  assert.equal(older.nextBefore, null)
  assert.equal(new Set([...first.entries, ...older.entries].map((e) => e.id)).size, 25)
  const { board } = await f.write('create_board', { name: 'Destination' })
  await f.write('move_task', {
    id: task.id,
    boardId: board.id,
    status: 'In progress',
    expectedRevision: f.store.task(task.id).revision
  })
  await f.write('rename_board', {
    id: board.id,
    expectedRevision: f.store.board(board.id).revision,
    name: 'Renamed destination'
  })
  assert.ok(
    (await activity(f, task.id)).entries.some((entry) => entry.summary === 'Project renamed')
  )
  await f.write('set_task_plan', {
    id: task.id,
    expectedMarkdown: '',
    markdown: '# Check everything'
  })
  f.store.saveAgentJob({
    id: 'activity-run',
    taskId: task.id,
    agent: 'codex',
    state: 'queued',
    workingFolder: f.folder,
    threadId: null,
    createdAt: new Date().toISOString(),
    summary: 'Waiting for Mac'
  })
  f.store.saveAgentJob({
    id: 'activity-run',
    taskId: task.id,
    agent: 'codex',
    state: 'working',
    workingFolder: f.folder,
    threadId: null,
    createdAt: new Date().toISOString(),
    summary: 'Checking the build',
    pickedUpAt: new Date().toISOString()
  })
  await f.write('companion_organize_task', { id: task.id, destination: 'archive' })
  await f.write('companion_organize_task', { id: task.id, destination: 'active' })
  await f.write('trash_task', { id: task.id, expectedRevision: f.store.task(task.id).revision })
  await f.write('restore_task', { id: task.id, expectedRevision: f.store.task(task.id).revision })
  const entries = (await activity(f, task.id)).entries
  for (const phrase of [
    'Moved from',
    'Plan updated',
    'Codex picked up',
    'Archived task',
    'Restored task from Archive',
    'Moved task to Trash',
    'Restored task from Trash'
  ])
    assert.ok(
      entries.some((e) => e.summary.includes(phrase)),
      phrase
    )
  f.reopen()
  assert.deepEqual((await activity(f, task.id)).entries, entries)
  for (const format of ['json', 'sqlite']) {
    const backup = await f.write('create_backup', { format }),
      preview = await f.store.dispatch('preview_destructive_action', {
        action: 'restore_backup',
        path: backup.path
      })
    await f.write('confirm_destructive_action', { token: preview.token })
    assert.ok((await activity(f, task.id)).entries.some((e) => e.id === entries[0].id))
    assert.equal((await activity(f, task.id)).entries[0].kind, 'restore')
  }
})
test('version ten upgrades preserve old reports, user feedback and screenshot IDs without inventing authorship', async (t) => {
  const f = fixture(t),
    { task } = await f.write('create_task', {
      boardId: f.store.boards()[0].id,
      title: 'Earlier task'
    })
  await f.write('add_user_comment', {
    taskId: task.id,
    text: 'Earlier unknown message',
    images: [png],
    notifyAgent: true
  })
  const comment = f.store.comments(task.id)[0],
    imageID = comment.images[0].id
  const original = { ...comment }
  delete original.source
  f.store.db
    .prepare('UPDATE task_comments SET data=? WHERE id=?')
    .run(JSON.stringify(original), comment.id)
  const agentID = randomUUID(),
    createdAt = new Date().toISOString()
  f.store.db.prepare('INSERT INTO task_comments VALUES (?,?,?)').run(
    agentID,
    task.id,
    JSON.stringify({
      id: agentID,
      taskId: task.id,
      text: 'Earlier agent report',
      createdAt,
      agent: 'codex',
      runId: 'old-run'
    })
  )
  f.store.db.exec(
    'DROP TABLE activity_images; DROP TABLE task_activity; DROP TABLE task_files; DELETE FROM schema_migrations WHERE version>=11; PRAGMA user_version=10'
  )
  f.reopen()
  assert.equal(f.store.task(task.id).commentCount, 0)
  assert.equal(f.store.comments(task.id).length, 1)
  assert.equal(f.store.comments(task.id)[0].source, 'legacy')
  assert.equal(f.store.comments(task.id)[0].delivery, 'local')
  let entries = (await activity(f, task.id)).entries
  assert.ok(entries.some((e) => e.actor === 'Codex' && e.detail === 'Earlier agent report'))
  assert.ok(entries.some((e) => e.actor === 'Earlier message' && e.images[0]?.id === imageID))
  assert.equal((await f.store.dispatch('read_comment_image', { imageId: imageID })).data, png.data)
  f.reopen()
  assert.deepEqual((await activity(f, task.id)).entries, entries)
})
test('invalid Activity backup is rejected before replacing the current workspace', async (t) => {
  const f = fixture(t),
    { task } = await f.write('create_task', {
      boardId: f.store.boards()[0].id,
      title: 'Keep current task'
    })
  await f.store.dispatch('add_task_activity', {
    taskId: task.id,
    text: 'Saved report',
    images: [png],
    requestKey: randomUUID()
  })
  const backup = await f.write('create_backup', { format: 'json' }),
    payload = JSON.parse(fs.readFileSync(backup.path))
  assert.equal(payload.activityImages.length, 1)
  const bad = structuredClone(payload)
  bad.activity[0].task_id = 'missing'
  fs.writeFileSync(backup.path, JSON.stringify(bad))
  await assert.rejects(f.store.dispatch('inspect_backup', { path: backup.path }), {
    code: 'INVALID_BACKUP'
  })
  assert.equal(f.store.task(task.id).title, 'Keep current task')
  fs.writeFileSync(backup.path, JSON.stringify(payload))
  const preview = await f.store.dispatch('preview_destructive_action', {
    action: 'restore_backup',
    path: backup.path
  })
  await f.write('confirm_destructive_action', { token: preview.token })
  const report = (await activity(f, task.id)).entries.find((e) => e.detail === 'Saved report')
  assert.equal(
    (await f.store.dispatch('read_comment_image', { imageId: report.images[0].id })).data,
    png.data
  )
})

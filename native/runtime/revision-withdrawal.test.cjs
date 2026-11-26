const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { Store } = require('./store.cjs')
const { AgentRunner } = require('./agent-runner.cjs')
const { Connector } = require('./mcp.cjs')
const { tools } = require('./contracts.cjs')

const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })
const image = {
  name: 'Screenshot.png',
  mimeType: 'image/png',
  data: fs.readFileSync(path.resolve(__dirname, '../assets/opentalon-logo-1024.png')).toString('base64'),
}

// The store, runner and withdrawal handler are wired the way the native service wires them.
function fixture(t) {
  const folder = fs.mkdtempSync(path.join(base, 'withdraw-'))
  const store = new Store(folder)
  const launched = []
  const runner = new AgentRunner({
    store,
    connector: {
      status: () => ({ enabled: true, running: true }),
      configuration: () => ({ mcpServers: { opentalon: { command: '/app', args: [], env: {} } } }),
    },
    openExternal: () => {},
    resolveExecutable: (agent) => '/safe/' + agent,
    spawnTransport(file, args, cwd, message, exit) {
      const entry = {
        file, args, message, exit, written: [], closed: false, hold: null,
        async request(method, params) {
          entry.written.push({ method, params })
          if (entry.hold?.method === method) await entry.hold.until
          if (method === 'thread/start') return { thread: { id: randomUUID() } }
          if (method === 'thread/resume') return { thread: { id: params.threadId } }
          if (method === 'turn/start') return { turn: { id: 'turn-1' } }
          return {}
        },
        write: (value) => entry.written.push(value),
        close() { entry.closed = true },
      }
      launched.push(entry)
      return entry
    },
  })
  runner.interruptTimeout = 40
  const cleanup = []
  t.after(async () => {
    for (const close of cleanup.reverse()) await close()
    await runner.close()
    store.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const write = (name, input, origin = 'You · mobile') =>
    store.dispatch(name, { requestKey: randomUUID(), ...input }, origin)
  const task = (title, status = 'In progress') =>
    write('create_task', { boardId: store.boards()[0].id, title, status }).then((result) => result.task)
  const previous = (task, agent = 'claude-code', state = 'review') => {
    const job = store.saveAgentJob({
      id: randomUUID(), taskId: task.id, agent, workingFolder: folder, threadId: randomUUID(),
      state, summary: 'First response', createdAt: new Date().toISOString(),
    })
    store.assignAgent(task.id, job.id)
    return job
  }
  const comment = (task, text, extra = {}) =>
    write('add_user_comment', { taskId: task.id, text, notifyAgent: true, ...extra }).then((result) => result.comment)
  // Mirrors native/service.cjs: the store decides, then only the named turn is ended.
  const withdraw = async (task, id, extra = {}) => {
    const result = await write('withdraw_revision_request', { taskId: task.id, id, ...extra })
    if (result.run?.stop) await runner.stopWithdrawnTurn(result.run.id)
    else if (result.run?.notify) await runner.notifyWithdrawal(result.run.id, result.run.notify)
    return result
  }
  const texts = (taskId) => store.comments(taskId).map(({ text }) => text)
  const turnText = (entry) => {
    const claude = entry.written.find(({ type }) => type === 'user')
    const codex = entry.written.find(({ method }) => method === 'turn/start')
    return claude ? claude.message.content[0].text : codex?.params.input[0].text
  }
  return { folder, store, runner, launched, cleanup, write, task, previous, comment, withdraw, texts, turnText }
}

test('withdrawal is a private native action and is never offered to connected agents', async (t) => {
  const f = fixture(t)
  assert.ok(!tools.some(({ name }) => name === 'withdraw_revision_request'))
  const task = await f.task('Private action')
  const saved = await f.comment(task, 'Only the user can withdraw this.')
  const connector = new Connector({ folder: f.folder, call: (name, args) => f.store.dispatch(name, args) })
  await connector.enable(true)
  f.cleanup.push(() => connector.stop())
  const response = await fetch(connector.status().endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connector.config.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'withdraw_revision_request', arguments: { taskId: task.id, id: saved.id, requestKey: randomUUID() } },
    }),
  })
  const reply = await response.json()
  assert.equal(reply.result.isError, true, 'An agent must not be able to withdraw the user’s request')
  assert.equal(reply.result.structuredContent.code, 'UNKNOWN_ACTION')
  assert.deepEqual(f.texts(task.id), ['Only the user can withdraw this.'])
})

test('a saved request is withdrawn once, recorded in Activity, and leaves its neighbours untouched', async (t) => {
  const f = fixture(t)
  const task = await f.task('Manual task')
  const keep = await f.comment(task, 'Keep this request.', { images: [image] })
  const drop = await f.comment(task, 'Withdraw this request.', { images: [image] })
  assert.equal(drop.delivery, 'local')
  const input = { taskId: task.id, id: drop.id, requestKey: randomUUID() }
  const first = await f.store.dispatch('withdraw_revision_request', input, 'You · mobile')
  assert.deepEqual(await f.store.dispatch('withdraw_revision_request', input, 'You · mobile'), first, 'A retried request replays its receipt')
  assert.equal(first.withdrawn, true)
  assert.equal(first.run, undefined)
  assert.deepEqual(f.texts(task.id), ['Keep this request.'])
  assert.equal(f.store.task(task.id).commentCount, 1)
  assert.equal(f.store.commentImage(keep.images[0].id).data, image.data)
  assert.throws(() => f.store.commentImage(drop.images[0].id), { code: 'NOT_FOUND' })
  const activity = await f.store.dispatch('list_task_activity', { taskId: task.id })
  const entry = activity.entries.find(({ summary }) => summary === 'Withdrew a revision request')
  assert.equal(entry.actor, 'You · mobile')
  assert.equal(entry.detail, 'Withdraw this request.')
  assert.equal(activity.entries.filter(({ summary }) => summary === 'Withdrew a revision request').length, 1)
  // A second, separate withdrawal of the same request is harmless.
  assert.equal((await f.withdraw(task, drop.id)).withdrawn, true)
  assert.deepEqual(f.texts(task.id), ['Keep this request.'])
})

test('a request can only be withdrawn from its own task, and only if the user wrote it', async (t) => {
  const f = fixture(t)
  const mine = await f.task('Owning task')
  const other = await f.task('Another task')
  const saved = await f.comment(mine, 'Belongs to the owning task.')
  await assert.rejects(f.withdraw(other, saved.id), { code: 'NOT_FOUND' })
  await assert.rejects(f.withdraw({ id: randomUUID() }, saved.id), { code: 'NOT_FOUND' })
  await assert.rejects(f.withdraw(mine, 'not-a-revision-id'), { code: 'NOT_FOUND' })
  f.store.db.prepare('INSERT INTO task_comments VALUES (?,?,?)').run('legacy-1', mine.id,
    JSON.stringify({ text: 'Earlier agent message', source: 'legacy', createdAt: new Date().toISOString(), delivery: 'local', runId: null, agent: null }))
  await assert.rejects(f.withdraw(mine, 'legacy-1'), { code: 'NOT_FOUND' })
  assert.equal(f.store.comments(mine.id).length, 2)
  assert.equal(f.store.comments(other.id).length, 0)
  // A withdrawal recorded for one task never blocks the same device ID on another task.
  const traveling = randomUUID()
  await f.withdraw(other, traveling)
  await assert.rejects(f.withdraw(mine, traveling), { code: 'NOT_FOUND' })
  const arrived = await f.comment(mine, 'Sent to the owning task.', { clientId: traveling })
  assert.equal(arrived.id, traveling)
})

test('a withdrawal that reaches the Mac first keeps the late request from ever being saved or delivered', async (t) => {
  const f = fixture(t)
  const task = await f.task('Offline race', 'Done')
  const run = f.previous(task)
  const stable = randomUUID().toUpperCase()
  const early = await f.withdraw(task, stable)
  assert.deepEqual({ withdrawn: early.withdrawn, received: early.received }, { withdrawn: true, received: false })
  const late = { taskId: task.id, text: 'Queued while offline.', notifyAgent: true, clientId: stable, requestKey: 'phone:' + stable }
  await assert.rejects(f.store.dispatch('add_user_comment', late, 'You · mobile'), { code: 'WITHDRAWN' })
  await assert.rejects(f.store.dispatch('add_user_comment', late, 'You · mobile'), { code: 'WITHDRAWN' }, 'Retries stay withdrawn')
  assert.equal(f.store.comments(task.id).length, 0)
  assert.equal((await f.store.queueCommentFollowups()).queued, 0)
  await f.runner.tick()
  assert.equal(f.launched.length, 0)
  assert.equal(f.store.assignedRun(task.id), run.id)
  assert.equal(f.store.task(task.id).status, 'Done')
  assert.equal((await f.withdraw(task, stable)).withdrawn, true)
})

test('a phone request keeps its device ID, so the phone can withdraw it without knowing the Mac’s copy', async (t) => {
  const f = fixture(t)
  const task = await f.task('Stable identity')
  const stable = randomUUID().toUpperCase()
  const saved = await f.comment(task, 'Named by the phone.', { clientId: stable, requestKey: 'phone:' + stable })
  assert.equal(saved.id, stable.toLowerCase())
  await assert.rejects(f.comment(task, 'A second request with the same ID.', { clientId: stable }), { code: 'CONFLICT' })
  await assert.rejects(f.comment(task, 'Bad ID', { clientId: 'request-1' }), { code: 'INVALID_ARGUMENT' })
  await f.withdraw(task, stable)
  assert.equal(f.store.comments(task.id).length, 0)

  // A request saved by an earlier Mac version has the Mac's own ID. Its receipt still names the phone request.
  const older = randomUUID().toUpperCase()
  const legacy = await f.comment(task, 'Saved before stable IDs.', { requestKey: 'phone:' + older })
  assert.notEqual(legacy.id, older.toLowerCase())
  // If its acknowledgement was lost, the updated Mac replays that receipt instead of failing or saving a copy.
  const replayed = await f.comment(task, 'Saved before stable IDs.', { requestKey: 'phone:' + older, clientId: older.toLowerCase() })
  assert.equal(replayed.id, legacy.id)
  assert.equal(f.store.comments(task.id).length, 1)
  await assert.rejects(f.comment(task, 'Different text.', { requestKey: 'phone:' + older, clientId: older.toLowerCase() }),
    { code: 'REQUEST_KEY_REUSED' })
  await f.withdraw(task, older.toLowerCase())
  assert.equal(f.store.comments(task.id).length, 0)
})

test('withdrawing the only request in a queued follow-up cancels that follow-up and nothing else', async (t) => {
  const f = fixture(t)
  const task = await f.task('Follow-up', 'Done')
  const other = await f.task('Unrelated', 'Done')
  const run = f.previous(task)
  const otherRun = f.previous(other, 'codex')
  const drop = await f.comment(task, 'Changed my mind.')
  const unrelated = await f.comment(other, 'Still wanted.')
  assert.equal((await f.store.queueCommentFollowups()).queued, 2)
  const followup = f.store.agentJobs().find((job) => job.taskId === task.id)
  const otherFollowup = f.store.agentJobs().find((job) => job.taskId === other.id)
  assert.equal(followup.previousRunId, run.id)
  assert.equal(f.store.comments(task.id)[0].delivery, 'queued')

  const result = await f.withdraw(task, drop.id)
  assert.equal(result.run, undefined, 'Nothing was running, so there is no turn to stop')
  assert.deepEqual(
    { state: f.store.agentJob(followup.id).state, summary: f.store.agentJob(followup.id).summary },
    { state: 'canceled', summary: 'Revision request withdrawn before delivery.' })
  assert.equal(f.store.assignedRun(task.id), run.id, 'The task returns to the run it had')
  assert.equal(f.store.agentJob(run.id).state, 'review')
  assert.equal(f.store.task(task.id).status, 'Done')
  assert.equal(f.store.agentJob(otherFollowup.id).state, 'queued')
  assert.equal(f.store.assignedRun(other.id), otherFollowup.id)
  assert.equal(f.store.comments(other.id)[0].delivery, 'queued')

  await f.runner.tick()
  assert.equal(f.launched.length, 1, 'Only the unrelated follow-up launches')
  assert.ok(f.turnText(f.launched[0]).includes(unrelated.text))
  assert.equal(f.store.agentJob(followup.id).state, 'canceled', 'The runner never revives the canceled follow-up')
  assert.equal(f.store.agentJob(otherRun.id).state, 'review')
})

test('withdrawing one of several queued requests delivers the rest; a dispatch still sends its task', async (t) => {
  const f = fixture(t)
  await f.write('set_agent_settings', { defaultAgent: 'claude-code', workingFolder: f.folder })
  const task = await f.task('Shared follow-up', 'Done')
  f.previous(task)
  const keep = await f.comment(task, 'Deliver this one.')
  const drop = await f.comment(task, 'Withdraw this one.')
  await f.store.queueCommentFollowups()
  const followup = f.store.agentJobs()[0]
  await f.withdraw(task, drop.id)
  assert.equal(f.store.agentJob(followup.id).state, 'queued')
  assert.deepEqual(f.store.agentJob(followup.id).commentIds, [keep.id])
  await f.runner.tick()
  assert.ok(f.turnText(f.launched[0]).includes('Deliver this one.'))
  assert.ok(!f.turnText(f.launched[0]).includes('Withdraw this one.'))
  await f.runner.finish(followup.id, 'review', 'Done')

  const fresh = await f.task('New dispatch', 'To do')
  const sent = await f.write('move_task', {
    id: fresh.id, expectedRevision: fresh.revision, status: 'Sent to agent', dispatchComment: 'Skip the dispatch note.',
  })
  const dispatchNote = f.store.comments(fresh.id)[0]
  const dispatch = f.store.agentJobs()[0]
  assert.equal(dispatch.dispatchCommentId, dispatchNote.id)
  await f.withdraw(fresh, dispatchNote.id)
  assert.equal(f.store.agentJob(dispatch.id).state, 'queued', 'The user still sent the task itself')
  assert.equal(f.store.agentJob(dispatch.id).dispatchCommentId, undefined)
  assert.equal(f.store.task(sent.task.id).status, 'Sent to agent')
  await f.runner.tick()
  assert.equal(f.launched.length, 2)
  assert.ok(f.turnText(f.launched[1]).includes('New dispatch'))
  assert.ok(!f.turnText(f.launched[1]).includes('Skip the dispatch note.'))
})

for (const agent of ['claude-code', 'codex'])
  test(`${agent}: a withdrawal during launch ends the turn before any request is written`, async (t) => {
    const f = fixture(t)
    const task = await f.task('In flight', 'Done')
    const run = f.previous(task, agent)
    const drop = await f.comment(task, 'Withdrawn while the agent was starting.')
    await f.store.queueCommentFollowups()
    const followup = f.store.agentJobs()[0]
    let release
    const until = new Promise((resolve) => { release = resolve })
    const original = f.runner.spawnTransport
    f.runner.spawnTransport = (...args) => Object.assign(original(...args), { hold: { method: 'initialize', until } })
    const launching = f.runner.tick()
    while (!f.launched.length) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.store.agentJob(followup.id).state, 'starting')
    assert.equal(f.runner.turnState(followup.id), 'unsent')

    const result = await f.withdraw(task, drop.id)
    assert.deepEqual(result.run, { id: followup.id, stop: true })
    release()
    await launching
    const entry = f.launched[0]
    assert.equal(f.turnText(entry), undefined, 'The withdrawn request never reached the agent')
    assert.ok(!entry.written.some(({ method }) => method === 'interrupt' || method === 'turn/interrupt'))
    assert.equal(entry.closed, true)
    assert.equal(f.runner.current, null)
    const ended = f.store.agentJob(followup.id)
    assert.deepEqual({ state: ended.state, summary: ended.summary },
      { state: 'canceled', summary: 'Revision request withdrawn before delivery.' })
    assert.equal(f.store.assignedRun(task.id), run.id)
    assert.equal(f.store.task(task.id).status, 'Done')
    assert.equal(f.store.comments(task.id).length, 0)
    await entry.exit(new Error('Late exit'))
    assert.equal(f.store.agentJob(followup.id).state, 'canceled')
  })

for (const agent of ['claude-code', 'codex'])
  test(`${agent}: a request already handed to its own turn stops that turn by asking the agent, never another run`, async (t) => {
    const f = fixture(t)
    const task = await f.task('Delivered', 'Done')
    const run = f.previous(task, agent)
    const drop = await f.comment(task, 'Already with the agent.')
    await f.store.queueCommentFollowups()
    const followup = f.store.agentJobs()[0]
    await f.runner.tick()
    const entry = f.launched[0]
    assert.ok(f.turnText(entry).includes('Already with the agent.'))
    assert.equal(f.runner.turnState(followup.id), 'sent')
    await entry.message(agent === 'claude-code'
      ? { type: 'system', subtype: 'init', session_id: run.threadId }
      : { method: 'turn/started', params: { turn: { id: 'turn-9' } } })
    assert.equal(f.store.comments(task.id)[0].delivery, 'delivered')
    // A second task waits in the queue behind the running turn.
    const waiting = await f.task('Queued behind', 'Done')
    f.previous(waiting, agent)
    await f.comment(waiting, 'Wait your turn.')
    await f.store.queueCommentFollowups()
    const queued = f.store.agentJobs()[0]

    const result = await f.withdraw(task, drop.id)
    assert.deepEqual(result.run, { id: followup.id, stop: true })
    const interrupt = entry.written.find(({ method }) => method === 'interrupt' || method === 'turn/interrupt')
    assert.ok(interrupt, 'The agent is asked to end its turn')
    if (agent === 'codex') assert.deepEqual(interrupt.params, { threadId: run.threadId, turnId: 'turn-9' })
    assert.equal(entry.closed, true)
    const ended = f.store.agentJob(followup.id)
    assert.equal(ended.state, 'canceled')
    assert.match(ended.summary, /revision request was withdrawn/)
    assert.equal(f.store.assignedRun(task.id), run.id)
    assert.equal(f.store.comments(task.id).length, 0)
    assert.equal(f.store.agentJob(queued.id).state, 'queued', 'The waiting run is untouched')
    assert.equal(f.store.comments(waiting.id)[0].delivery, 'queued')
    // The same withdrawal replayed after the turn ended stops nothing new.
    await f.runner.stopWithdrawnTurn(followup.id)
    await f.runner.tick()
    assert.equal(f.launched.length, 2)
    assert.ok(f.turnText(f.launched[1]).includes('Wait your turn.'))
  })

test('work the agent already applied is never marked stopped or withdrawn', async (t) => {
  const f = fixture(t)
  const task = await f.task('Applied work', 'Done')
  const run = f.previous(task)
  const applied = await f.comment(task, 'Apply this first.')
  const second = await f.comment(task, 'Then this.')
  await f.store.queueCommentFollowups()
  const followup = f.store.agentJobs()[0]
  await f.runner.tick()
  const entry = f.launched[0]
  await entry.message({ type: 'system', subtype: 'init', session_id: run.threadId })
  await f.write('add_task_activity', { taskId: task.id, text: 'Applied the first request.', commentIds: [applied.id] }, 'Claude')

  await assert.rejects(f.withdraw(task, applied.id), { code: 'INVALID_STATE', message: /already acted on/ })
  assert.equal(entry.closed, false)
  assert.equal(f.store.agentJob(followup.id).state, 'working')
  assert.equal(f.store.comments(task.id).find(({ id }) => id === applied.id).delivery, 'delivered')

  // With the first request applied, the second is the turn's only remaining work, so the turn ends.
  const result = await f.withdraw(task, second.id)
  assert.deepEqual(result.run, { id: followup.id, stop: true })
  const ended = f.store.agentJob(followup.id)
  assert.equal(ended.state, 'review', 'Applied work is left for review')
  assert.match(ended.summary, /Completed revision work is ready for review/)
  assert.equal(f.store.assignedRun(task.id), followup.id)
  const kept = f.store.comments(task.id)
  assert.deepEqual(kept.map(({ id }) => id), [applied.id])
  assert.ok(kept[0].actedOnAt)
  assert.equal(kept[0].activityState, 'review')
  await assert.rejects(f.write('report_agent_progress', { runId: followup.id, state: 'working', summary: 'Late report' }, 'Claude'),
    { code: 'INACTIVE_RUN' })
})

for (const agent of ['claude-code', 'codex'])
  test(`${agent}: a request sharing an active turn is invalidated and its run is told to skip it while the rest continues`, async (t) => {
    const f = fixture(t)
    const task = await f.task('Shared turn', 'Done')
    const other = await f.task('Other running context', 'Done')
    const run = f.previous(task, agent)
    const keep = await f.comment(task, 'Keep working on this.')
    const drop = await f.comment(task, 'Skip this after all.')
    const elsewhere = await f.comment(other, 'Unrelated request.')
    f.previous(other, agent)
    await f.store.queueCommentFollowups()
    const followup = f.store.agentJobs().find((job) => job.taskId === task.id)
    const otherFollowup = f.store.agentJobs().find((job) => job.taskId === other.id)
    // The runner launches the newest queued job last, so cancel order does not matter here.
    while (f.runner.current?.job.id !== followup.id) {
      if (f.runner.current) await f.runner.finish(f.runner.current.job.id, 'review', 'Finished')
      await f.runner.tick()
    }
    const entry = f.launched.at(-1)
    assert.ok(f.turnText(entry).includes('Skip this after all.'))
    await entry.message(agent === 'claude-code'
      ? { type: 'system', subtype: 'init', session_id: run.threadId }
      : { method: 'turn/started', params: { turn: { id: 'turn-4' } } })
    const before = entry.written.length

    const input = { taskId: task.id, id: drop.id, requestKey: randomUUID() }
    const result = await f.store.dispatch('withdraw_revision_request', input, 'You · mobile')
    assert.deepEqual(result.run, { id: followup.id, notify: { id: drop.id, text: 'Skip this after all.' } })
    await f.runner.notifyWithdrawal(result.run.id, result.run.notify)
    // A retried request replays its receipt and must not message the agent twice.
    const replay = await f.store.dispatch('withdraw_revision_request', input, 'You · mobile')
    await f.runner.notifyWithdrawal(replay.run.id, replay.run.notify)
    const sent = entry.written.slice(before)
    assert.equal(sent.length, 1)
    const note = agent === 'claude-code' ? sent[0].message.content[0].text : sent[0].params.input[0].text
    if (agent === 'codex') {
      assert.equal(sent[0].method, 'turn/steer')
      assert.equal(sent[0].params.expectedTurnId, 'turn-4')
    }
    assert.ok(note.includes(drop.id) && note.includes('Skip this after all.'))
    assert.ok(!entry.written.some(({ method }) => method === 'interrupt' || method === 'turn/interrupt'), 'The shared turn is not interrupted')
    assert.equal(entry.closed, false)

    const job = f.store.agentJob(followup.id)
    assert.equal(job.state, 'working')
    assert.deepEqual(job.commentIds, [keep.id])
    assert.deepEqual(f.store.comments(task.id).map(({ id }) => id), [keep.id])
    assert.equal(f.store.comments(task.id)[0].delivery, 'delivered')
    assert.equal(f.store.comments(other.id)[0].id, elsewhere.id)
    assert.notEqual(f.store.agentJob(otherFollowup.id).state, 'canceled')

    // The run's own tool calls repeat the withdrawal. The user's and other tasks' reads do not.
    const asAgent = (name, fields) => f.store.dispatch(name, fields, 'Connected agent')
    const listed = await asAgent('list_task_comments', { taskId: task.id })
    assert.deepEqual(listed.withdrawnRevisionRequests.map(({ id }) => id), [drop.id])
    assert.match(listed.withdrawalNotice, /Do not start or continue work on them/)
    assert.ok((await asAgent('get_task', { id: task.id })).withdrawalNotice)
    assert.equal((await asAgent('get_task', { id: other.id })).withdrawalNotice, undefined)
    assert.equal((await f.store.dispatch('list_task_comments', { taskId: task.id }, 'You · Mac')).withdrawalNotice, undefined)

    // The withdrawn request can no longer be claimed, and no receipt is owed for it.
    await assert.rejects(f.write('add_task_activity', { taskId: task.id, text: 'Did both.', commentIds: [keep.id, drop.id] }, 'Claude'),
      { code: 'WITHDRAWN' })
    const done = await f.write('report_agent_progress', {
      runId: followup.id, state: 'done', summary: 'Finished the remaining request.',
      proof: 'Ran the focused checks for the remaining request and all of them passed.',
      definitionOfDoneMet: true, actedOnCommentIds: [keep.id],
    }, 'Claude')
    assert.equal(done.run.state, 'done')
    assert.equal(f.store.task(task.id).status, 'Done')
    assert.ok(f.store.comments(task.id)[0].actedOnAt)
    assert.equal((await asAgent('get_task', { id: task.id })).withdrawalNotice, undefined, 'A finished run is no longer notified')
  })

test('a request sent with a task’s first dispatch is withdrawn without stopping the task', async (t) => {
  const f = fixture(t)
  await f.write('set_agent_settings', { defaultAgent: 'claude-code', workingFolder: f.folder })
  const fresh = await f.task('First dispatch', 'To do')
  await f.write('move_task', { id: fresh.id, expectedRevision: fresh.revision, status: 'Sent to agent', dispatchComment: 'Sent with the task.' })
  const dispatch = f.store.agentJobs()[0]
  await f.runner.tick()
  const entry = f.launched[0]
  await entry.message({ type: 'system', subtype: 'init', session_id: f.store.agentJob(dispatch.id).threadId })
  const note = f.store.comments(fresh.id)[0]
  assert.ok(note.pickedUpAt)
  const result = await f.withdraw(fresh, note.id)
  assert.equal(result.run.notify.id, note.id)
  assert.equal(entry.closed, false)
  assert.equal(f.store.agentJob(dispatch.id).state, 'working')
  assert.equal(f.store.task(fresh.id).status, 'In progress')
  assert.equal(f.store.comments(fresh.id).length, 0)
  assert.ok(entry.written.at(-1).message.content[0].text.includes('withdrew revision request'))

  // A received request whose run already ended without acting on it is simply removed.
  const again = await f.task('Ended run', 'To do')
  await f.write('move_task', { id: again.id, expectedRevision: again.revision, status: 'Sent to agent', dispatchComment: 'Never acted on.' })
  const second = f.store.agentJobs()[0]
  await f.runner.finish(dispatch.id, 'review', 'Finished')
  await f.runner.tick()
  await f.launched[1].message({ type: 'system', subtype: 'init', session_id: f.store.agentJob(second.id).threadId })
  await f.runner.finish(second.id, 'review', 'Ended without a receipt')
  const stale = f.store.comments(again.id)[0]
  assert.equal(stale.delivery, 'needs-review')
  const ended = await f.withdraw(again, stale.id)
  assert.equal(ended.run, undefined)
  assert.equal(f.store.comments(again.id).length, 0)
  assert.equal(f.store.agentJob(second.id).state, 'review')
  assert.equal(f.store.assignedRun(again.id), second.id)
})

test('an undelivered request that needs review can be withdrawn and is not retried', async (t) => {
  const f = fixture(t)
  const task = await f.task('Needs review', 'Done')
  const run = f.previous(task)
  const drop = await f.comment(task, 'Never reached the agent.')
  await f.store.queueCommentFollowups()
  const followup = f.store.agentJobs()[0]
  await f.store.updateAgentJob(followup.id, { state: 'failed', summary: 'Launch failed' })
  assert.equal(f.store.comments(task.id)[0].delivery, 'needs-review')
  await f.withdraw(task, drop.id)
  assert.equal(f.store.comments(task.id).length, 0)
  assert.equal(f.store.agentJob(followup.id).state, 'failed', 'A finished run keeps its recorded outcome')
  await assert.rejects(f.write('retry_task_comment', { id: drop.id }), { code: 'NOT_FOUND' })
  assert.equal((await f.store.queueCommentFollowups()).queued, 0)
  assert.equal(f.store.agentJob(run.id).state, 'review')
})

test('backups made after a withdrawal restore without the withdrawn request', async (t) => {
  const f = fixture(t)
  const target = fixture(t)
  const task = await f.task('Portable')
  const keep = await f.comment(task, 'Kept across restore.')
  const drop = await f.comment(task, 'Withdrawn before backup.')
  await f.withdraw(task, drop.id)
  for (const format of ['json', 'sqlite']) {
    const backup = await f.write('create_backup', { format })
    const preview = await target.store.dispatch('preview_destructive_action', { action: 'restore_backup', path: backup.path })
    await target.write('confirm_destructive_action', { token: preview.token })
    assert.deepEqual(target.store.comments(task.id).map(({ id }) => id), [keep.id])
    const activity = await target.store.dispatch('list_task_activity', { taskId: task.id })
    assert.ok(activity.entries.some(({ summary }) => summary === 'Withdrew a revision request'))
  }
})

// Runs the real native service process the Mac app talks to, over its JSON-line transport.
function nativeService(t) {
  const staged = fs.mkdtempSync(path.join(base, 'withdraw-service-'))
  const data = fs.mkdtempSync(path.join(base, 'withdraw-data-'))
  for (const file of fs.readdirSync(__dirname))
    if (file.endsWith('.cjs') && !file.endsWith('.test.cjs')) fs.copyFileSync(path.join(__dirname, file), path.join(staged, file))
  for (const file of ['service.cjs', 'daily-backup.cjs'])
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(staged, file))
  const child = spawn(process.execPath, [path.join(staged, 'service.cjs'), data, process.execPath, '0.1.0'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, HOME: data, PATH: '/usr/bin:/bin', CODEX_APP_RUNTIME_CLI_PATH: '' },
  })
  const closed = once(child, 'close')
  const requests = new Map()
  let ready
  const started = new Promise((resolve, reject) => { ready = resolve; child.on('close', () => reject(new Error('Service exited.'))) })
  started.catch(() => {})
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line)
    if (response.event === 'ready') ready()
    const pending = requests.get(response.id)
    if (!pending) return
    requests.delete(response.id)
    if (response.error) pending.reject(Object.assign(new Error(response.error.message), response.error))
    else pending.resolve(response.data)
  })
  t.after(async () => {
    child.stdin.end()
    await closed
    fs.rmSync(staged, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  })
  return async (name, input = {}) => {
    await started
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      requests.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ id, name, input }) + '\n')
    })
  }
}

test('the native service applies phone withdrawals end to end and reports them in the phone snapshot', { timeout: 30000 }, async (t) => {
  const call = nativeService(t)
  const phone = (name, input) => {
    const request = randomUUID().toUpperCase()
    return call(name, { requestKey: 'phone:' + request, ...input }).then((result) => ({ request, result }))
  }
  const { boards } = await call('snapshot')
  const { result: created } = await phone('create_task', { boardId: boards[0].id, title: 'Phone revisions' })
  const task = created.task
  const { result: other } = await phone('create_task', { boardId: boards[0].id, title: 'Other task' })

  // The Mac saves the phone's request under the phone's own request ID.
  const sent = randomUUID().toUpperCase()
  const saved = await call('add_user_comment', {
    requestKey: 'phone:' + sent, taskId: task.id, text: 'From the phone.', notifyAgent: false, clientId: sent.toLowerCase(),
  })
  assert.equal(saved.comment.id, sent.toLowerCase())
  await phone('add_user_comment', { taskId: task.id, text: 'Stays on the task.', notifyAgent: false })
  let snapshot = await call('native_phone_snapshot')
  assert.deepEqual(snapshot.commentsByTask[task.id].map(({ text, delivery }) => [text, delivery]),
    [['From the phone.', 'local'], ['Stays on the task.', 'local']])

  await assert.rejects(phone('withdraw_revision_request', { taskId: other.task.id, id: sent.toLowerCase() }), { code: 'NOT_FOUND' })
  await assert.rejects(call('withdraw_revision_request', { taskId: task.id, id: sent.toLowerCase() }), { code: 'INVALID_ARGUMENT' },
    'A request key is required so retries replay')
  const { request, result } = await phone('withdraw_revision_request', { taskId: task.id, id: sent.toLowerCase() })
  assert.equal(result.withdrawn, true)
  const replay = await call('withdraw_revision_request', { requestKey: 'phone:' + request, taskId: task.id, id: sent.toLowerCase() })
  assert.deepEqual(replay, result)
  snapshot = await call('native_phone_snapshot')
  assert.deepEqual(snapshot.commentsByTask[task.id].map(({ text }) => text), ['Stays on the task.'])
  assert.ok(snapshot.workspace.revision >= result.revision)
  const activity = await call('list_task_activity', { taskId: task.id })
  const entry = activity.entries.find(({ summary }) => summary === 'Withdrew a revision request')
  assert.equal(entry.actor, 'You · mobile')

  // Withdrawn while still in transit: the late request is refused when it arrives.
  const late = randomUUID().toUpperCase()
  await phone('withdraw_revision_request', { taskId: task.id, id: late.toLowerCase() })
  await assert.rejects(call('add_user_comment', {
    requestKey: 'phone:' + late, taskId: task.id, text: 'Arrived after its withdrawal.', notifyAgent: false, clientId: late.toLowerCase(),
  }), { code: 'WITHDRAWN' })
  snapshot = await call('native_phone_snapshot')
  assert.deepEqual(snapshot.commentsByTask[task.id].map(({ text }) => text), ['Stays on the task.'])
  assert.equal(snapshot.commentsByTask[other.task.id], undefined)
})

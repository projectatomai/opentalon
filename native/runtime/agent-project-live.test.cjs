const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { AgentRunner, JsonProcess, executable } = require('./agent-runner.cjs')

test('real Codex retains one OpenTalon project across process restarts and changes only with cwd', {
  skip: process.env.OPENTALON_CODEX_PROJECT_TEST !== '1', timeout: 120000,
}, async (t) => {
  const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
  fs.mkdirSync(base, { recursive: true })
  const folder = fs.mkdtempSync(path.join(base, 'project-contract-'))
  const home = path.join(folder, 'codex-home')
  const workspace = path.join(folder, 'OpenTalon')
  const changed = path.join(folder, 'Changed OpenTalon folder')
  for (const directory of [home, workspace, changed]) fs.mkdirSync(directory)
  const originalHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  t.after(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalHome
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const runner = new AgentRunner({})
  let firstId
  for (const cwd of [workspace, workspace, changed]) {
    const transport = new JsonProcess(executable('codex'), ['app-server', '--listen', 'stdio://'], cwd, () => {}, () => {})
    const closed = once(transport.child, 'close')
    try {
      await transport.request('initialize', {
        clientInfo: { name: 'opentalon-project-contract', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      transport.write({ method: 'initialized', params: {} })
      const id = await runner.codexProject(transport, cwd, cwd)
      assert.ok(id, 'This installed Codex must support saved projects')
      const projects = (await transport.request('project/list', { limit: 100 })).data
      assert.equal(projects.length, cwd === changed ? 2 : 1)
      assert.equal(projects.find(project => project.id === id).name, 'OpenTalon')
      if (!firstId) firstId = id
      else if (cwd === workspace) assert.equal(id, firstId)
      else assert.notEqual(id, firstId)
      const { thread } = await transport.request('thread/start', {
        cwd, projectId: id, runtimeWorkspaceRoots: [cwd], ephemeral: false,
        approvalPolicy: 'on-request', sandbox: 'read-only', serviceName: 'opentalon',
      })
      assert.equal(thread.projectId, id)
      assert.equal(thread.cwd, cwd)
    } finally { transport.close(); await closed }
  }
  // This is an isolated, model-free client. It never touches the user's Codex projects or login.
})

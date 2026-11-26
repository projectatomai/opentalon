const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { promisify } = require('node:util')
const { agentWorkingDirectory } = require('./agent-readiness.cjs')

const base = process.env.OPENTALON_TEST_ROOT || '/Volumes/Expand/Projects/OpenTalon/native-app/tests'
fs.mkdirSync(base, { recursive: true })

// Intercept only the provider process. Exercise real command construction, file IO and cleanup.
function provider(calls) {
  const execFile = () => {}
  execFile[promisify.custom] = (file, args, options) => {
    const promise = new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          calls.push({ file, args, ...options })
          const outputIndex = args.indexOf('--output-last-message')
          const isDraft = args.includes('--json-schema') || args.includes('--output-schema')
          const draft = { title: 'A task', notes: 'A concrete goal', definitionOfDone: 'Verified result' }
          if (outputIndex !== -1)
            fs.writeFileSync(args[outputIndex + 1], isDraft ? JSON.stringify(draft) : 'Workspace verified')
          resolve({ stdout: JSON.stringify(isDraft ? { structured_output: draft } : { result: 'Workspace verified' }) })
        } catch (error) { reject(error) }
      })
    })
    promise.child = { stdin: { on() {}, end() {} } }
    return promise
  }
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, 'agent-runner.cjs'), 'utf8')
  const load = vm.runInThisContext(`(function(require,module,exports){${source}\n})`)
  load((name) => name === 'node:child_process'
    ? { ...require(name), execFile }
    : name === 'node:fs' ? { ...fs, accessSync() {} }
    : require(name), module, module.exports)
  return module.exports
}

test('chat and drafting use the configured folder for both agents, never their scratch files', async (t) => {
  const folder = fs.mkdtempSync(path.join(base, 'workspace-contract-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const scratch = path.join(folder, 'scratch')
  const workspace = path.join(folder, 'OpenTalon')
  const alias = path.join(folder, 'Alias')
  fs.mkdirSync(scratch)
  fs.mkdirSync(workspace)
  fs.symlinkSync(workspace, alias)
  const calls = []
  const { askAgent, draftTask } = provider(calls)
  for (const agent of ['claude-code', 'codex']) {
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await askAgent(agent, {
        directory: scratch, workingFolder: alias,
        config: { command: '/connector', args: [], env: { OPENTALON_MCP_CONFIG: '/config' } },
        message: 'Show tasks', history: [], project: 'Any board',
      })).text, 'Workspace verified')
      assert.equal((await draftTask(agent, 'Create a task', { workingFolder: alias })).title, 'A task')
    }
  }
  assert.equal(calls.length, 8)
  for (const call of calls) {
    assert.equal(call.cwd, fs.realpathSync(workspace))
    assert.equal(call.env.PWD, call.cwd)
    if (call.args.includes('--output-schema')) {
      const schema = call.args[call.args.indexOf('--output-schema') + 1]
      assert.ok(!schema.startsWith(workspace + path.sep))
      assert.equal(fs.existsSync(path.dirname(schema)), false, 'Draft scratch files were cleaned')
    }
  }
  assert.deepEqual(fs.readdirSync(workspace), [], 'Helpers must not litter the working folder')
})

test('missing working folders fail closed without inventing a project directory', async () => {
  for (const folder of ['', 'relative/folder', path.join(base, 'nonexistent-workspace')])
    assert.throws(() => agentWorkingDirectory(folder), { code: 'AGENT_SETUP_REQUIRED' })
  const calls = []
  const { askAgent, draftTask } = provider(calls)
  await assert.rejects(askAgent('codex', { directory: base }), { code: 'AGENT_SETUP_REQUIRED' })
  await assert.rejects(draftTask('claude-code', 'Anything'), { code: 'AGENT_SETUP_REQUIRED' })
  assert.equal(calls.length, 0)
})

test('saved Full access applies to subsequent chats and drafts for both agents while Automatic stays the initial mode', async t => {
  const folder = fs.mkdtempSync(path.join(base, 'workspace-permissions-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const calls = []
  const { askAgent, draftTask } = provider(calls)
  for (const agent of ['claude-code', 'codex']) {
    for (const permissionMode of [undefined, 'full-access', 'full-access', 'auto']) {
      const options = { directory: folder, workingFolder: folder, permissionMode,
        config: { command: '/connector', args: [], env: { OPENTALON_MCP_CONFIG: '/config' } }, message: 'Show tasks', history: [] }
      await askAgent(agent, options)
      await draftTask(agent, 'Create a task', options)
      for (const call of calls.slice(-2)) {
        if (agent === 'claude-code') {
          const index = call.args.indexOf('--permission-mode')
          assert.equal(index >= 0, permissionMode === 'full-access')
          if (index >= 0) assert.equal(call.args[index + 1], 'bypassPermissions')
          assert.equal(call.args.includes('--restricted'), permissionMode !== 'full-access')
          assert.equal(call.args[call.args.indexOf('--tools') + 1], '')
        } else {
          assert.equal(call.args[call.args.indexOf('--sandbox') + 1], permissionMode === 'full-access' ? 'danger-full-access' : 'read-only')
          assert.ok(call.args.includes('shell_tool'))
        }
      }
    }
  }
})

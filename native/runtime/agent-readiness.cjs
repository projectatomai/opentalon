const fs = require('node:fs')
const path = require('node:path')
const { AppError } = require('./contracts.cjs')

function agentWorkingDirectory(folder) {
  try {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory())
      throw new Error('Unavailable working folder')
    return fs.realpathSync(folder)
  } catch {
    throw new AppError('AGENT_SETUP_REQUIRED', 'The agent folder is unavailable. Choose an existing folder in the project’s Agent folder settings, or use the global folder in Settings.')
  }
}

function assertAgentReady(settings, runtimes, connection) {
  if (!settings.workingFolder)
    throw new AppError(
      'AGENT_SETUP_REQUIRED',
      'Choose where your agent should work before sending this task.'
    )
  try {
    if (!fs.statSync(settings.workingFolder).isDirectory()) throw new Error('Not a folder')
  } catch {
    throw new AppError(
      'AGENT_SETUP_REQUIRED',
      'The working folder is unavailable. Choose another folder to send this task.'
    )
  }
  if (!runtimes[settings.defaultAgent]?.installed)
    throw new AppError(
      'AGENT_NOT_INSTALLED',
      'Install your selected agent’s launcher and sign in, or choose another agent.'
    )
  if (!connection.running)
    throw new AppError('MCP_DISABLED', 'Enable the local agent connection to send this task.')
}
module.exports = { assertAgentReady, agentWorkingDirectory }

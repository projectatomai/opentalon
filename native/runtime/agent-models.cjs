// Verified November 22, 2026 against OpenAI's Codex model/list and the
// OpenAI/Anthropic model documentation. Keep current defaults here, not on mobile.
// https://openai.com/index/introducing-gpt-6-2-astra-sol/
// https://platform.claude.com/docs/en/models/overview
// Gemini verified November 23, 2026. Gemini 3.8 Flash and Gemini 4 Hydrogen, Carbon,
// Neon and Argon are generally available (https://aistudio.google.com/docs/changelog).
// Tasks run through the Antigravity CLI, which takes agent model slugs with a thinking
// level, not API IDs (https://antigravity.google/docs/models).
// Gemini's "Agent default" is the first Gemini model in the owner's list. Flash ships
// first because every Google plan includes it. The Gemini 4 models depend on the plan.
const defaultsVersion = '2026-11-23'
const agentNames = { 'claude-code': 'Claude', codex: 'Codex', gemini: 'Gemini' }
const agentIds = Object.keys(agentNames)
const agentModels = [
  { agent: 'claude-code', id: 'claude-fable-5-2', title: 'Claude Fable 5.2' },
  { agent: 'claude-code', id: 'claude-opus-5-5', title: 'Claude Opus 5.5' },
  { agent: 'claude-code', id: 'claude-sonnet-5-5', title: 'Claude Sonnet 5.5' },
  { agent: 'claude-code', id: 'claude-haiku-5-5', title: 'Claude Haiku 5.5' },
  { agent: 'codex', id: 'gpt-6.2-sol', title: 'GPT-6.2 Sol' },
  { agent: 'codex', id: 'gpt-6.2-astra', title: 'GPT-6.2 Astra' },
  { agent: 'codex', id: 'gpt-6.1-terra', title: 'GPT-6.1 Terra' },
  { agent: 'gemini', id: 'gemini-3.8-flash-high', title: 'Gemini 3.8 Flash' },
  { agent: 'gemini', id: 'gemini-4-hydrogen-high', title: 'Gemini 4 Hydrogen' },
  { agent: 'gemini', id: 'gemini-4-carbon-high', title: 'Gemini 4 Carbon' },
  { agent: 'gemini', id: 'gemini-4-neon-high', title: 'Gemini 4 Neon' },
  { agent: 'gemini', id: 'gemini-4-argon-high', title: 'Gemini 4 Argon' },
]

function validateModelOverrides(overrides) {
  if (!Array.isArray(overrides) || overrides.length > 100) throw new Error('Use at most 100 model overrides.')
  const keys = new Set()
  return overrides.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['agent', 'id', 'title', 'hidden'].includes(key)) ||
        !agentIds.includes(entry.agent) ||
        typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/.test(entry.id) ||
        typeof entry.title !== 'string' || !entry.title.trim() || entry.title.trim().length > 80 ||
        !entry.title.isWellFormed() || /\p{Cc}/u.test(entry.title) ||
        (entry.hidden !== undefined && typeof entry.hidden !== 'boolean'))
      throw new Error('Use a valid agent, model ID, display name and optional hidden flag.')
    const key = `${entry.agent}:${entry.id}`
    if (keys.has(key)) throw new Error('Each model ID must be unique for its agent.')
    keys.add(key)
    return { agent: entry.agent, id: entry.id, title: entry.title.trim(), hidden: entry.hidden === true }
  })
}

function mergeAgentModels(defaults, overrides) {
  const changes = new Map(overrides.map(entry => [`${entry.agent}:${entry.id}`, entry]))
  const models = []
  for (const model of defaults) {
    const key = `${model.agent}:${model.id}`
    const override = changes.get(key)
    if (!override?.hidden) models.push({ ...model, title: override?.title ?? model.title })
    changes.delete(key)
  }
  for (const override of changes.values()) {
    if (!override.hidden) models.push({ agent: override.agent, id: override.id, title: override.title })
  }
  return models
}

module.exports = { agentModels, agentNames, agentIds, defaultsVersion, validateModelOverrides, mergeAgentModels }

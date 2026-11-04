/**
 * 数字分身地基（plan 目标 9，11-01）：负责人 persona 与人员画像。
 *   · runtime/persona/aven.md：aven 自己写的说明（口吻、取舍、哪些事归他、哪些一律拒），进分类器与代答提示；没有文件就没有这块。
 *   · runtime/people.json：每个找过 bot 的人自动累积（名字 / 角色 / 问过几次 / 最近聊的主题），分类器据此知道「这是谁、常问什么」。
 * 只做读写与渲染，不含业务判断；gateway 与 worker 都引（纯文件 IO，无子进程）。
 * node --test 下且没显式给 path 时 notePerson 不落盘，免得单测把假人写进真实运行态（与发件簿 / 义务同口径）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { larkRuntimeDir } from './lark-paths.mjs'

export const PERSONA_PATH = join(larkRuntimeDir, 'persona', 'aven.md')
export const PEOPLE_PATH = join(larkRuntimeDir, 'people.json')
const TOPICS_MAX = 10
const TRUNCATED = '（截断）'

const clip = (text, maxChars) => (text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}${TRUNCATED}` : text)

// 文件缺失 / 读不到 / 空白 → null（调用方当「没有 persona」）。
export const loadPersona = ({ path = PERSONA_PATH } = {}) => {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

// 给提示用的一块：超过 maxChars 截断并标「（截断）」，没有 persona 返回空串。
export const personaBlock = ({ maxChars = 900, path } = {}) => {
  const text = loadPersona({ path })
  return text ? `【负责人（aven）的说明，以他的口吻和取舍判断】\n${clip(text, maxChars)}` : ''
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const loadPeople = ({ path = PEOPLE_PATH } = {}) => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// 记一笔（upsert）：问过几次 +1、最近见到、主题新的在前最多 10 个（同主题去重）；原子写 tmp+rename、0600（群里人名与聊的内容不该 world-readable）。
export const notePerson = ({ openId, name = null, role = null, topic = null, chatId = null, taskId = null, now = Date.now(), path } = {}) => {
  if (!openId) return null
  if (!path && process.env.NODE_TEST_CONTEXT) return null
  const file = path || PEOPLE_PATH
  const people = loadPeople({ path: file })
  const prev = isPlainObject(people[openId]) ? people[openId] : {}
  const at = new Date(now).toISOString()
  const cleanTopic = typeof topic === 'string' && topic.trim() ? topic.trim().slice(0, 60) : null
  const topics = Array.isArray(prev.topics) ? prev.topics.filter((item) => item?.topic && item.topic !== cleanTopic) : []
  const entry = {
    ...prev,
    openId,
    name: name || prev.name || null,
    role: role || prev.role || null,
    askedCount: (Number(prev.askedCount) || 0) + 1,
    firstSeenAt: prev.firstSeenAt || at,
    lastSeenAt: at,
    lastChatId: chatId || prev.lastChatId || null,
    lastTaskId: taskId || prev.lastTaskId || null,
    topics: (cleanTopic ? [{ topic: cleanTopic, at, taskId: taskId || null }, ...topics] : topics).slice(0, TOPICS_MAX),
  }
  people[openId] = entry
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(people, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return entry
}

// memberRoles（config，可选）：{ ou_x: '前端' } 或 { ou_x: { name, role } }；ownerMap（config.ownerMap）：角色关键词 → open_id，反查得角色。
const roleFromConfig = (openId, { ownerMap = {}, memberRoles = {} }) => {
  const member = memberRoles?.[openId]
  if (typeof member === 'string' && member.trim()) return { name: null, role: member.trim() }
  if (isPlainObject(member)) return { name: member.name || null, role: member.role || null }
  const keyword = Object.entries(ownerMap || {}).find(([, id]) => id === openId)?.[0]
  return { name: null, role: keyword || null }
}

// 只要名字（任务上记 operatorName，补充 / 提示里说清是谁说的）：画像里的名字 > memberRoles 里写的名字 > ownerMap 的键（分类器 describeSender、
// 出口 mergedAskers 都把它当名字用）；都没有 null。
export const personName = (openId, { people = {}, ownerMap = {}, memberRoles = {} } = {}) => {
  if (!openId) return null
  const person = isPlainObject(people?.[openId]) ? people[openId] : {}
  const member = isPlainObject(memberRoles?.[openId]) ? memberRoles[openId] : {}
  return person.name || member.name || Object.entries(ownerMap || {}).find(([, id]) => id === openId)?.[0] || null
}

// 「名字（角色）」/「名字」/「未登记成员（ou_…）」：people.json 的名字优先，角色先看画像再看配置。
export const describePerson = (openId, { people = {}, ownerMap = {}, memberRoles = {} } = {}) => {
  const person = isPlainObject(people?.[openId]) ? people[openId] : {}
  const fromConfig = roleFromConfig(openId, { ownerMap, memberRoles })
  const name = person.name || fromConfig.name || null
  const role = person.role || fromConfig.role || null
  if (!name) return `未登记成员（${openId || '?'}）`
  return role ? `${name}（${role}）` : name
}

// 这几个人的画像（分类器提示用）：只列画像里有的人，一人一行；没有返回空串；整块超 maxChars 截断。
export const peopleBlock = ({ openIds = [], people = {}, maxChars = 400 } = {}) => {
  const lines = [...new Set(openIds.filter(Boolean))]
    .map((openId) => (isPlainObject(people?.[openId]) ? people[openId] : null))
    .filter((person) => person && person.name)
    .map((person) => {
      const topics = (person.topics || []).map((item) => item?.topic).filter(Boolean).slice(0, 3)
      return `- ${describePerson(person.openId, { people })}：找过 bot ${Number(person.askedCount) || 0} 次${topics.length ? `，最近聊过：${topics.join(' / ')}` : ''}`
    })
  return lines.length ? clip(`【这些人的画像（自动累积）】\n${lines.join('\n')}`, maxChars) : ''
}

import type { LlmProfileSavePayload, LlmProfileWrite } from '../shared/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}不能为空`)
  return value.trim()
}

function parseProfile(value: unknown, create: boolean): LlmProfileWrite {
  if (!isRecord(value)) throw new TypeError('模型线路参数无效')
  const id = requiredString(value.id, '线路 ID')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new TypeError('线路 ID 只能包含小写字母、数字和连字符')
  }
  const baseUrl = requiredString(value.base_url, 'Base URL')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new TypeError('Base URL 必须是有效网址')
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
    throw new TypeError('Base URL 必须使用 HTTPS')
  }
  if (value.api_type !== 'openai-completions') throw new TypeError('API 类型无效')
  if (typeof value.api_key !== 'string') throw new TypeError('API Key 必须是字符串')
  if (create && !value.api_key.trim()) throw new TypeError('新建线路时 API Key 不能为空')
  if (!Array.isArray(value.models) || value.models.some((model) => typeof model !== 'string')) {
    throw new TypeError('模型列表无效')
  }
  if (typeof value.enabled !== 'boolean') throw new TypeError('启用状态无效')
  if (typeof value.sort_order !== 'number' || !Number.isFinite(value.sort_order)) {
    throw new TypeError('排序值无效')
  }
  return {
    id,
    display_name: requiredString(value.display_name, '显示名称'),
    base_url: baseUrl.replace(/\/$/, ''),
    api_type: 'openai-completions',
    api_key: value.api_key.trim(),
    models: [...new Set(value.models.map((model) => model.trim()).filter(Boolean))],
    enabled: value.enabled,
    sort_order: value.sort_order,
  }
}

export function parseLlmProfileSavePayload(value: unknown): LlmProfileSavePayload {
  if (!isRecord(value) || typeof value.create !== 'boolean') {
    throw new TypeError('模型线路保存参数无效')
  }
  return value.create
    ? { create: true, profile: parseProfile(value.profile, true) }
    : { create: false, profile: parseProfile(value.profile, false) }
}

export function parseLlmProfileId(value: unknown): string {
  const id = requiredString(value, '线路 ID')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new TypeError('线路 ID 格式无效')
  }
  return id
}

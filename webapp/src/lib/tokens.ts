/**
 * NAI prompt token 粗估。
 *
 * 环境无 tiktoken/transformers，沿用项目其它工具的经验公式（见 feedback_*.md token 近似法）：
 *   approx_tok = round(words × 1.3) + 标点数（逗号 + :: + — + .）
 * 仅供「占用多少 / 会不会爆」的量级判断，不是精确 CLIP token 数。
 *
 * NAI V4.5 每个字段（base_caption / 各 char_caption）是独立预算。经验阈值：
 *   ≤ soft  绿（安全）
 *   ≤ hard  黄（接近上限，自然语言密集时易开始丢细节）
 *   > hard  红（高危，大概率结构/细节崩）
 */
export function estimateTokens(text: string): number {
  const t = (text || '').trim()
  if (!t) return 0
  const words = t.split(/\s+/).filter(Boolean).length
  const commas = (t.match(/,/g) || []).length
  const dcolon = (t.match(/::/g) || []).length
  const emdash = (t.match(/—/g) || []).length
  const dots = (t.match(/\./g) || []).length
  return Math.round(words * 1.3) + commas + dcolon + emdash + dots
}

export type TokenLevelName = 'ok' | 'warn' | 'high'

export function tokenLevel(tok: number, soft = 160, hard = 225): { level: TokenLevelName; color: string } {
  if (tok <= soft) return { level: 'ok', color: '#3a9b6e' }
  if (tok <= hard) return { level: 'warn', color: '#d39000' }
  return { level: 'high', color: '#d33' }
}

// 来源：docs_tdd commit 165b070 的 common/engine/agent-scripts/lib/lark-prd-drift.mjs（拆仓时只复制
// parseLarkDocumentPayload 及其 contentHash 依赖链；漂移比对、媒体本地化与 selfTest 未复制）。
// 解析 docs +fetch 信封，并对正文做稳定规范化后计算 hash。
// 临时媒体下载 URL 每次 fetch 都可能变化，必须剔除；正文、结构、稳定 token 和文案仍参与指纹。

import { createHash } from 'node:crypto'

const TEMPORARY_MEDIA_URL_RE = /https?:\/\/[^\s"')>]+\/space\/api\/box\/stream\/download\/authcode\/\?code=[^\s"')>]+/gi

// 剥离「同一 PRD 内容、不同 fetch」之间必然波动的媒体元数据：临时下载令牌（每次 fetch 轮换）、
// markdown 图片描述与 HTML alt 文案（AI/OCR 生成，同图每次措辞不同、非确定性）。
// 真实文字/结构/表格/资产字节不受影响，指纹仍能检出真变更。
export function stripVolatileMediaMetadata(content) {
  return String(content || '')
    .replace(TEMPORARY_MEDIA_URL_RE, '<lark-temporary-media-url>')
    .replace(/!\[(?:\\.|[^\]])*\]/g, '![]')
    .replace(/(<img\b[^>]*?)\s+alt\s*=\s*("[^"]*"|'[^']*')([^>]*>)/gi, '$1$3')
}

export function canonicalizeLarkDocumentContent(content) {
  return stripVolatileMediaMetadata(String(content || '').replace(/\r\n?/g, '\n'))
    // 落盘副本会剔除行尾空白，就地重算指纹时必须同口径剔除，否则与直连 fetch 的原始正文因行尾空白必然不等。
    .replace(/[ \t]+$/gm, '')
    .trim()
}

export function hashCanonicalLarkContent(content) {
  return createHash('sha256').update(canonicalizeLarkDocumentContent(content)).digest('hex')
}

export function parseLarkDocumentPayload(stdout) {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Lark docs +fetch returned invalid JSON: ${error.message}`)
  }

  const document = payload?.data?.document
  if (payload?.ok !== true || typeof document?.content !== 'string') {
    throw new Error('Lark docs +fetch response is missing data.document.content')
  }

  return {
    content: document.content,
    contentHash: hashCanonicalLarkContent(document.content),
    documentId: String(document.document_id || ''),
    revisionId: document.revision_id === undefined || document.revision_id === null
      ? ''
      : String(document.revision_id),
    identity: String(payload.identity || ''),
  }
}

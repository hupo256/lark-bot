/**
 * 改码单里给了登录账号时，分析阶段自己登录取证（11-04 b3「stuck」两例）：
 * - ep-1030-167d28：online 状态类缺陷挂着等 Network 证据，aven 私信「自己登录进去看看，这个是账号：734343862@qq.com Test1234」续跑；
 *   分析阶段只翻代码，结论还是「缺 online 接口实际返回、请用复现账号抓包」，账号原样没用；
 * - ep-1023-9f0fd7：HTStone「請嘗試郵箱登入 郵箱：… 密碼：…」并进兑换缺陷单重跑，结论「请后端核对这个号的绑定状态」，没登录看。
 * 实测模式（VERIFICATION_MODE_BLOCK）有环境实测规则、允许登录 POST；改码模式的分析提示只要求「金额 / 状态 / 权限类取不到 API 实际返回判 blocked」，
 * 却没给取证的路。出网命令层对改码档本就放行登录 POST（lib/lark-egress-policy），缺的只是提示。只在正文像带了账号时出现，不进系统层。
 * 纯函数、零 IO。
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
const ACCOUNT_LABEL_RE = /(?:账号|帐号|帳號|賬號|账户|用户名|郵箱|邮箱|手机号|uid|account|user(?:name)?)\s*[:：]\s*\S/i
const LOGIN_CUE_RE = /密码|密碼|password|passwd|pwd|登录|登入|登陆|登錄|login|sign\s*in/i

// 正文里像带了能登录的账号：有账号（邮箱或「账号：x」）且有密码 / 登录字样。
export const hasLoginCredentials = (text) => {
  const input = String(text || '')
  return (EMAIL_RE.test(input) || ACCOUNT_LABEL_RE.test(input)) && LOGIN_CUE_RE.test(input)
}

const siteList = (envSites) => Object.entries(envSites || {}).filter(([, url]) => typeof url === 'string' && url.trim()).map(([env, url]) => `${env} ${url}`)

export const buildCredentialProbeBlock = ({ envSites = null } = {}) => {
  const sites = siteList(envSites)
  const where = sites.length ? `打 ${sites.join('、')}（上下文说哪个环境就测哪个）` : '本仓没配环境地址，测不了就写明'
  return `上下文给了登录账号（任务内容 / 补料 / 前文里）：要环境事实（接口实际返回、账号状态、页面表现）就本轮自己用它登录去取，不再把「缺 Network 证据 / 缺账号 / 请对方抓包」写成 blocker。${where}；只发 GET，登录拿态的 POST（含验证码登录）除外；不注册、不发帖评论、不下单改数据，要写数据才能复现的那步写明卡在哪、请谁做。取到的返回就是 API 实际值证据，summary / requirements 写清测了什么、看到什么；账号密码不写进任何给人看的字段。`
}

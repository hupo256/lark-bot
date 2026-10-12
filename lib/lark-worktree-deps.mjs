import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// installArgs：仓库 profile 指定的安装命令参数（如单包仓 `['install','--frozen-lockfile','--prefer-offline']`），
// 缺省沿用 monorepo 的 `--filter <根包名>` 定向安装。
export const prepareRootTools = (cwd, { installArgs = null } = {}) => {
  const manifestPath = join(cwd, 'package.json')
  if (!existsSync(manifestPath) || !existsSync(join(cwd, '.husky', 'pre-commit'))) return
  if (!existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    throw new Error('Husky worktree 缺少 pnpm-lock.yaml，不能确认提交工具版本')
  }
  const modules = join(cwd, 'node_modules')
  let isLink = false
  try {
    isLink = lstatSync(modules).isSymbolicLink()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (isLink) {
    throw new Error('worktree 的 node_modules 是外部软链，不能跨分支复用业务依赖')
  }
  if (existsSync(join(cwd, '.husky', '_', 'husky.sh')) &&
    existsSync(join(modules, '.bin', 'lint-staged')) &&
    existsSync(join(modules, '.bin', 'biome'))) return
  const { name, packageManager } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!packageManager?.startsWith('pnpm@') || (!installArgs && !name)) {
    throw new Error('目标仓缺少明确的 pnpm 包名或版本，无法准备提交工具')
  }
  const started = Date.now()
  const args = installArgs || ['--filter', name, 'install', '--frozen-lockfile', '--prefer-offline']
  const result = spawnSync('pnpm', args, {
    cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 300000,
  })
  if (result.status !== 0) {
    throw new Error(`根包工具准备失败：${(result.stderr || result.stdout || result.error?.message || '未知错误').trim().slice(-1000)}`)
  }
  if (!existsSync(join(cwd, '.husky', '_', 'husky.sh')) ||
    !existsSync(join(modules, '.bin', 'lint-staged')) ||
    !existsSync(join(modules, '.bin', 'biome'))) {
    throw new Error('根包安装后 Husky/lint-staged/Biome 仍不可用，不能绕过提交 hook')
  }
  console.log(`[lark-worker] 根包提交工具已准备（${Date.now() - started}ms，无全量 workspace 安装）`)
}

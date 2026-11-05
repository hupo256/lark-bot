// 薄转发（11-05 P1）：本体在 packages/mail-relay/forward.mjs。lark-bot 内置时 run 由 lib/lark-mail-relay.mjs 的 createRelayCli 注入。
export * from '../packages/mail-relay/forward.mjs'

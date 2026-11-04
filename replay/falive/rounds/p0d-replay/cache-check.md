## ep-1029-f09207
A：4 次调用；B：4 次调用
B 按类 hit/miss/bypass：other 0/0/1，intent 2/0/0，task-ro 1/0/0
ok   B 只读调用命中率 100.0%（3/3，门槛 90%）
B 可写调用命中 0/0（参考，不设门槛：上游任何一次 miss 都会让业务仓状态分叉）
B 直通原因：
  1 × other：输出格式 text（拿不到 result 事件判成败）
ok   群回复一致（A 4 条 / B 4 条）
ok   任务终态一致（2 个任务）

全部通过

## ep-1023-98f8fa
A：3 次调用；B：3 次调用
B 按类 hit/miss/bypass：other 0/0/1，intent 1/0/0，task-ro 1/0/0
ok   B 只读调用命中率 100.0%（2/2，门槛 90%）
B 可写调用命中 0/0（参考，不设门槛：上游任何一次 miss 都会让业务仓状态分叉）
B 直通原因：
  1 × other：输出格式 text（拿不到 result 事件判成败）
ok   群回复一致（A 3 条 / B 3 条）
ok   任务终态一致（1 个任务）

全部通过

## ep-1102-0f579b
A：3 次调用；B：3 次调用
B 按类 hit/miss/bypass：other 0/0/1，intent 1/0/0，task-ro 1/0/0
ok   B 只读调用命中率 100.0%（2/2，门槛 90%）
B 可写调用命中 0/0（参考，不设门槛：上游任何一次 miss 都会让业务仓状态分叉）
B 直通原因：
  1 × other：输出格式 text（拿不到 result 事件判成败）
ok   群回复一致（A 4 条 / B 4 条）
ok   任务终态一致（1 个任务）

全部通过


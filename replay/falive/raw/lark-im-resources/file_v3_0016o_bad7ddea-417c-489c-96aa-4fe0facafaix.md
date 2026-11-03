# 直播间介绍 `intro` 接口变更说明（前端对接）

- 分支：`b2b/bug-4944`
- 日期：2026-10-23
- 范围：直播主站 API（App / H5 / PC）与嗨聊对接 API；后台「机器人开播」表单同步加了同一栏位（不是 API，附在文末供知晓）
- 字段细节与完整响应示例以 [02-直播间与开播](live-接口与业务说明/02-直播间与开播.md)、[11-嗨聊对接](live-接口与业务说明/11-嗨聊对接.md) 为准，本文只列**变化点**和前端要做的事。

## 一、概述

主播开播 / 修改直播间时可以填写**直播间介绍**（`intro`），直播间详情与「我的直播记录」会把它回传。字段为新增、**全部可选**：
不传 `intro` 的旧版本客户端不受影响，接口行为与现在完全一致。

## 二、字段定义

| 项 | 值 |
|---|---|
| 字段名 | `intro`（请求参数与响应字段同名） |
| 类型 | string |
| 长度 | **最多 200 字**，按字数计（中英文、emoji 都算 1 字），不按字节 |
| 处理 | 服务端去掉首尾空白后保存；没填为空串 `""`，不会是 `null` |
| 换行 | 允许，原样保存 / 回传（前端按需 `white-space: pre-line` 之类展示） |
| 缓存 | 直播间详情（各 `getRoomInfo`）有最长 **120 秒**缓存，改完介绍后详情不会立刻变；「我的直播记录」`getRoomList` 不走这层缓存，立刻可见 |

## 三、有变化的接口一览

| 接口 | 变化 | 字段位置 | 前端要做的事 |
|---|---|---|---|
| `GET\|POST /api/live/createRoom` | 请求参数 **+`intro`**（可选） | — | 开播表单加「直播间介绍」输入框 |
| `GET\|POST /api/live/updateLive` | 请求参数 **+`intro`**（可选） | — | 修改直播间表单加输入框；**只有要改时才传** |
| `GET\|POST /api/live/getRoomList` | 响应 **+`intro`** | `data.data[].intro` | 编辑页回填、列表按需展示 |
| `GET\|POST /api/li_stre/getRoomInfo` | 响应 **+`intro`** | `data.info.intro` | 直播间页展示 |
| `GET\|POST /api/live_streaming/getRoomInfo`（旧版） | 响应 **+`intro`** | `data.info.intro` | 同上 |
| `GET\|POST /api/preload/getRoomInfo`（预加载） | 响应 **+`intro`** | `data.info.intro` | 同上 |
| `GET\|POST /api/hi_chat_anchor_management/createRoom`（嗨聊） | 请求参数 **+`intro`**（可选） | — | 嗨聊开播表单加输入框 |
| `GET\|POST /api/hi_chat_anchor_management/updateLive`（嗨聊） | 请求参数 **+`intro`**（可选） | — | 嗨聊修改直播间表单加输入框；只有要改时才传 |
| `GET\|POST /api/hi_chat_anchor_management/getRoomList`（嗨聊） | 响应 **+`intro`** | `data.data[].intro` | 编辑页回填 |
| `GET\|POST /api/hi_chat_program/getRoomInfo`（嗨聊） | 响应 **+`intro`** | `data.info.intro` | 直播间页展示 |

**没有变化**（没加 `intro`，不要在这些接口上找）：`/api/li_stre/getLiveList`、`/api/front/liveList`、`/api/live/getRoomInfoMr`、搜索 / 榜单 / 预约列表、
`/api/hi_chat_program/getBclLiveList`。列表卡片若也要显示介绍，另提需求。

## 四、请求参数变化

### 4.1 创建直播：`/api/live/createRoom`、`/api/hi_chat_anchor_management/createRoom`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| intro | string | 否 | `""` | 直播间介绍，≤ 200 字；不传 / 传空都存空串 |

其余参数不变。

### 4.2 修改直播间：`/api/live/updateLive`、`/api/hi_chat_anchor_management/updateLive`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| intro | string | 否 | — | 直播间介绍，≤ 200 字。**请求带了才改**：不带这个参数 → 保留原介绍；带空串 `""` → 清空 |

> 注意「不带」和「带空串」语义不同。修改表单用整包提交时，请把回填的原值一起带上，否则用户没动介绍也会被清空。

## 五、响应字段变化

### 5.1 直播间详情（4 支 `getRoomInfo`）

`data.info` 新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `info.intro` | string | 直播间介绍；没填为 `""`。未开播 / 已关播时也会回（取主播最近一场的值） |

```json
{
  "msg": "操作成功", "code": 0,
  "data": {
    "info": {
      "id": 77812, "uid": 520031, "islive": 1, "title": "英超赛前聊球",
      "intro": "每晚八点英超前瞻，欢迎进房聊球",
      "thumb": "https://cdn.example.com/upload/live/2026/1007/cover_520031.jpg",
      "...": "其余字段不变"
    },
    "vid": "8f14e45fceea167a5a36dedd4bea2543", "reserve": [], "userData": { "...": "不变" }
  }
}
```

主播不存在时 `info` 仍是近乎空的对象，`intro` 为 `""`，不要按 `undefined` 判断。

### 5.2 我的直播记录（`getRoomList`，前台与嗨聊）

`data.data[]` 每条新增 `intro`（string，没填为 `""`）：

```json
{ "id": 77812, "uid": 520031, "islive": 0, "title": "英超赛前聊球", "intro": "每晚八点英超前瞻，欢迎进房聊球", "thumb": "...", "...": "其余字段不变" }
```

## 六、错误

| 场景 | 返回 |
|---|---|
| `intro` 去空白后超过 200 字 | 业务错误（`code` 同本模块其它业务错误），`msg` 为多语言文案 `LIVE_ROOM_INTRO_TOO_LONG`（中文：「直播间介绍最多200字」）；不落库、其它字段也不保存 |

前端建议输入框 `maxlength=200` 并显示字数，服务端仍会二次校验。

## 七、兼容性

- 全部新增字段，无删除 / 改名 / 改类型；旧版本客户端不传 `intro` 照常可用。
- 响应新增 key 对解密后的 `data` 结构无破坏；生产环境仍是请求 `sec` 解密后读，不要依赖明文 `data`。
- 上线顺序由后端控制（先加列再发代码），前端无需配合灰度。

## 八、附：后台（非前端 API）

后台「机器人直播 → 创建 / 修改直播间」表单新增「直播间介绍」文本框（同样 200 字），保存后前台 `getRoomInfo` 同样能看到；定时任务自动建房不会改动已填的介绍。

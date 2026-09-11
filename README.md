# Holdem Lab

一个以独立规则核心为基础的 Web 德州扑克项目。目标是让本机牌局、局域网房间、Bot、回放和策略实验复用同一套状态与动作协议。

## 当前版本

第一开发切片已经可以运行：

- 本机单挑桌：Human 对基础 Bot
- 服务端持有完整 `GameState`，浏览器只提交 `PlayerAction`
- Fold / Check / Call / Raise / All-in
- 翻牌前到摊牌的完整流程
- 确定性洗牌、牌型比较、平局拆分
- 玩家专属视图，对手暗牌只在摊牌时公开
- 动作 ID 去重、手牌与状态版本校验
- 操作记录、牌型帮助、底池快捷加注

当前版本用于验证核心链路，尚未实现多人边池、房间大厅、持久化和断线身份恢复。

## 运行

需要 Node.js 当前 LTS 版本。

```bash
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。牌局服务默认监听 `ws://127.0.0.1:8787`。

## 验证

```bash
npm test
npm run build
```

## 目录

```text
apps/web          React 牌桌界面
apps/server       本机权威牌局服务
packages/core     无 UI、网络和数据库依赖的规则核心
packages/protocol 浏览器与服务端消息契约
```

下一阶段优先扩展通用 2–8 人座位、主池与多层边池，再增加局域网房间和会话恢复。

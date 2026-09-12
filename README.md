# Holdem Lab

一个由服务端权威规则驱动的 Web 德州扑克系统，可用于本机练习、局域网多人、回放和策略实验。

## 已完成功能

- 2–8 人无限注德州扑克，覆盖完整街道、最小加注、短筹码 All-in、未跟注筹码退回、主池、多层边池、平分底池和奇数筹码分配。
- Human 与 Bot 统一提交 `PlayerAction`，规则核心不依赖 React、WebSocket、数据库或 AI。
- 局域网大厅：创建房间、输入房间码加入、座位容量、Human + Bot 混合牌桌和房主开局。
- 房主可选择积分桌或淘汰赛，设置起始筹码、大小盲、限定手数或不限手数。
- 筹码用完后成员留在牌桌观战；积分桌可申请补充筹码，由房主批准并在下一手入局，所有发放记录进入房间账本。
- 房间生命周期：刷新或短暂断线会恢复原座位；主动离桌会立即弃掉本手并保留座位与筹码，大厅可直接返回牌桌。
- 无真人在线时房间暂停，Bot 不再继续自战；10 分钟无人返回后自动关闭房间并清理成员会话。
- 房间、牌局和最近 20 手回放保存到本地 JSON；房主可随时解散房间。
- 所有成员读取不含隐藏牌的公开 `TableView`；参赛玩家另获只含本人底牌和合法动作的 `PlayerView`。Bot 只接收自己的 `DecisionContext`。
- 服务器行动倒计时：Bot 自动行动，真人超时自动过牌或弃牌。
- 本手记录、10 种完整牌型示例、逐动作回放、JSON 导出、确定性随机种子复现。
- 2–8 人批量模拟及胜局统计；当前只启用基础跟注策略。
- 单端口生产运行：同一 Node 服务提供网页、WebSocket 和健康检查，便于部署到普通云容器。

Monte Carlo、CFR、GTO、RL 按要求只保留插件接口。实现新算法时注册 `StrategyPlugin`，其 `decide` 方法只能读取 `DecisionContext`，无需修改规则核心、房间服务或 UI。

## 本机与局域网运行

需要 Node.js 当前 LTS 版本。

```bash
npm install
npm run dev
```

- 本机打开 `http://127.0.0.1:5173`
- 局域网设备打开 `http://<运行电脑的局域网 IP>:5173`
- 牌局服务监听 `0.0.0.0:8787`

## 生产或云容器运行

```bash
npm run build
PORT=8787 npm start
```

访问 `http://<服务器地址>:8787`。反向代理只需把 HTTP 与 WebSocket 一并转发到同一端口，HTTPS 页面会自动使用 WSS。

可选环境变量：

- `PORT`：HTTP 与 WebSocket 端口。
- `HOLDEM_DATA_FILE`：牌局与会话 JSON 的保存位置。
- `HOLDEM_WEB_DIST`：网页构建目录。
- `VITE_WS_URL`：网页与牌局服务分开部署时的 WebSocket 地址。

当前 JSON 持久化实现了单机恢复。迁移到多实例云服务时，实现 `PersistenceAdapter` 并替换为数据库或共享存储即可，协议和规则核心不需要变化。

## 验证

```bash
npm test
npm run build
curl http://127.0.0.1:8787/health
```

## 目录

```text
apps/web          React 大厅、多人牌桌、回放与模拟界面
apps/server       房间引擎、Session、WebSocket、倒计时与持久化
packages/core     纯规则核心、牌型计算、边池与确定性回放
packages/protocol 网络消息、房间视图与版本契约
packages/bot      Bot 策略插件边界、基础策略与批量模拟
```

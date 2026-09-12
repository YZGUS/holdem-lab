# Holdem Lab

Holdem Lab 是一个服务端权威驱动的 Web 德州扑克项目，支持本机练习、局域网多人、Human + Bot 混合牌桌、断线恢复和确定性回放。

## 快速开始

### 环境要求

- [Git](https://git-scm.com/)
- Node.js `20.19+` 或 `22.12+`
- npm（随 Node.js 安装）

### 1. 克隆项目

```bash
git clone https://github.com/YZGUS/holdem-lab.git
cd holdem-lab
```

### 2. 安装依赖

```bash
npm ci
```

### 3. 启动本地服务

```bash
npm run dev
```

该命令会同时启动网页和牌局服务，请保持终端运行。

- 本机访问：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- Web 开发服务：`0.0.0.0:5173`
- 牌局与 WebSocket 服务：`0.0.0.0:8787`

## 局域网多人

1. 运行服务的电脑执行 `npm run dev`。
2. 查看这台电脑的局域网 IP。macOS 使用 Wi-Fi 时通常可执行：

   ```bash
   ipconfig getifaddr en0
   ```

3. 其他设备连接同一个局域网，打开：

   ```text
   http://<运行电脑的局域网 IP>:5173
   ```

4. 一台设备创建房间，其他设备输入 6 位房间码加入。

如果页面可以打开但显示未连接，请确认两个开发进程均在运行，并允许 Node.js 通过系统防火墙。

## 已实现功能

- 2–8 人无限注德州扑克：完整街道、最小加注、短筹码 All-in、未跟注筹码退回、主池、多层边池、平分底池和奇数筹码分配。
- 局域网大厅：创建房间、房间码加入、座位容量、Human + Bot 混合牌桌和房主开局。
- 积分桌与淘汰赛：可设置起始筹码、大小盲、限定手数和补充筹码规则。
- 房间生命周期：刷新或短暂断线恢复座位；主动离桌保留座位与筹码；无真人在线时暂停；房主可解散房间。
- 观战与补充：筹码用完后留桌观战，积分桌可申请补充，审批通过后下一手入局。
- 整局结算：展示冠军、最终筹码、总带入、净成绩和最终排名。
- History 与 Replay：本手记录、最近 20 手回放、逐动作播放、JSON 导出和随机种子复现。
- 独立表现层：错峰发牌、3D 翻牌、筹码移动、胜利效果、SFX 与 BGM 独立开关和音量。
- 响应式界面：支持桌面、窄屏分屏和手机牌桌，辅助信息通过 Drawer 展示。
- 隐藏信息隔离：所有成员读取公开 `TableView`，参赛玩家只额外获得本人底牌与合法动作；Bot 只能读取自己的 `DecisionContext`。
- Bot 与模拟：当前启用基础策略，并保留 Monte Carlo、CFR、GTO 和 RL 的 `StrategyPlugin` 接口。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动 Web 与牌局开发服务 |
| `npm test` | 运行规则核心、Bot 和房间服务测试 |
| `npm run build` | 构建全部 workspace |
| `npm start` | 启动已构建的单端口生产服务 |

## 生产运行

```bash
npm ci
npm run build
PORT=8787 npm start
```

访问 `http://<服务器地址>:8787`。生产模式由同一个 Node.js 服务提供网页、WebSocket 和健康检查；如使用反向代理，需同时转发 HTTP 和 WebSocket。

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

### 可选环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | 生产 HTTP 与 WebSocket 端口 |
| `HOLDEM_DATA_FILE` | `.data/server-state.json` | 房间、会话与牌局 JSON 保存位置 |
| `HOLDEM_WEB_DIST` | `apps/web/dist` | Web 构建文件目录 |
| `VITE_WS_URL` | 同源 `/ws` | Web 与牌局服务分开部署时的 WebSocket 地址 |

## 项目结构

```text
apps/web          React 大厅、牌桌、表现层、结算、回放与响应式界面
apps/server       RoomEngine、Session、WebSocket、倒计时与本地持久化
packages/core     纯规则核心、牌型计算、边池、历史与确定性回放
packages/protocol 网络消息、房间视图和版本契约
packages/bot      Bot 策略插件边界、基础策略与批量模拟
```

`GameState` 是唯一事实源。Human 和 Bot 统一生成 `PlayerAction`，由规则核心验证和执行。UI、动画、音效和网络层只消费公开状态与事件，不能直接改变牌局结果。

## 验证

```bash
npm test
npm run build
```

当前 JSON 持久化适用于单机和单实例部署。迁移到多实例云服务时，可通过 `PersistenceAdapter` 替换为数据库或共享存储，规则核心与网络协议无需重写。

# 修复同步功能完全不可用的问题

> 创建时间：2026-03-31
> 最后更新：2026-04-01

## 问题描述

最新一次提交 `49fa042` 为了支持 mobile 兼容性，对传输层做了大规模重构，导致桌面端同步功能完全失效。

## 根因分析

提交 `49fa042` 做了以下改动，其中多处引入了问题：

### 已确认的问题

1. **ws-server.ts 动态 require 导致 ws 未打包**（已修复）
   - 原来：`import { WebSocketServer } from 'ws'`（静态导入，esbuild 会打包）
   - 改为：`getDynamicRequire()('ws')`（运行时动态调用，esbuild 看不到）
   - 后果：`ws` 包不再被打入 bundle（190KB vs 原来的 237KB），运行时找不到 ws 模块
   - 修复：恢复静态 `import { WebSocketServer } from 'ws'`，仅用 `supportsIncomingConnections()` 做运行时守卫

2. **ws-client.ts 使用 `globalThis.WebSocket` 替代 `ws` 库的 WebSocket**（待修复）
   - 原来：`import { WebSocket } from 'ws'`（使用 ws 库的 WebSocket 类）
   - 改为：`const WebSocketCtor = globalThis.WebSocket`（依赖浏览器/Electron 原生 WebSocket）
   - 问题：原生 WebSocket 和 ws 库的 WebSocket 行为差异较大（如 binaryType 默认值不同、事件模型不同）
   - 需要验证在 Electron/Obsidian 环境中是否正常工作

3. **socket.ts 抽象层的 addEventListener 兼容性问题**（待验证）
   - `addSocketListener` 优先使用 `addEventListener`，ws 库的 socket 同时支持 `on` 和 `addEventListener`
   - 但 `addEventListener` 路径下，close/error 事件的 wrapped 函数丢弃了参数：`const wrapped = (() => listener()) as EventListener`
   - 而 error 事件需要传递错误对象：`addSocketErrorListener` 注册的 listener 期望收到 `(error: unknown)` 参数
   - 这会导致错误处理丢失错误信息

4. **udp-broadcast.ts 动态 require dgram**（待评估）
   - 同样的模式：`getDynamicRequire()('dgram')` 
   - 但 `dgram` 在 esbuild external 列表的 `builtins` 中，不会被打包，所以运行时需要 Node require 来加载
   - 在桌面端 `getDynamicRequire()` 返回非 null（Electron 有 require），所以应该可以工作
   - 但如果 `getDynamicRequire()` 的 Function trick 被 CSP 策略阻止，就会失败

5. **network.ts 动态 require os**（待评估）
   - 与 dgram 同理

## 修复计划

### Phase 1：恢复桌面端基本同步（优先级最高）

1. [x] ws-server.ts：恢复静态 import ws
2. [ ] ws-client.ts：恢复静态 import ws 的 WebSocket，同时保留 mobile fallback 逻辑
3. [ ] socket.ts：修复 `addSocketListener` 中 wrapped 函数丢弃参数的问题
4. [ ] 验证 connection-manager.ts 的握手流程完整可用

### Phase 2：验证辅助功能

5. [ ] 验证 udp-broadcast.ts 的 getDynamicRequire 在桌面端可用
6. [ ] 验证 network.ts 的 getDynamicRequire 在桌面端可用
7. [ ] 端到端测试：两台桌面设备之间的完整同步流程

### Phase 3：Mobile 兼容性（如果需要的话）

8. [ ] 设计合理的桌面/移动端代码分离策略
9. [ ] 确保 mobile 端优雅降级而不影响桌面端

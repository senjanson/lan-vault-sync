# 修复同步功能 - 任务清单

> 进度：4 / 7 已完成
> 最后更新：2026-04-01

## 已完成

- [x] **ws-server.ts 改为条件式 require**：去掉静态 `import { WebSocketServer } from 'ws'`，改为在 `start()` 方法内 `supportsIncomingConnections()` 守卫后 `require('ws')`。esbuild 仍打包 ws（识别 require 调用），但 `__commonJS` 惰性包装器确保模块代码只在桌面端执行
- [x] **ws-client.ts 条件式加载 WebSocket**：去掉静态 `import { WebSocket } from 'ws'`，改为 `_doConnect()` 中条件判断：`canUseNodeRuntime()` → `require('ws').WebSocket`（桌面），否则 → `globalThis.WebSocket`（移动端）
- [x] **socket.ts addSocketListener 丢参数 bug**：`const wrapped = (() => listener()) as EventListener` 改为 `((...args: any[]) => listener(...args))`，修复 error 事件 listener 收不到 error 对象的问题
- [x] **验证 bundle 惰性加载**：非压缩构建确认 `require_ws()` 只在 `canUseNodeRuntime()`/`supportsIncomingConnections()` 守卫内调用，ws 内部的 `require("http")` 等全在 `__commonJS` 包装器中，mobile 端不会触发

## 待完成

- [ ] **验证 udp-broadcast.ts**：确认 `getDynamicRequire()('dgram')` 在桌面 Electron 环境下正常工作（dgram 是 Node builtin，不被 esbuild 打包）
- [ ] **验证 network.ts**：确认 `getDynamicRequire()('os')` 在桌面 Electron 环境下正常工作
- [ ] **端到端测试**：在 Obsidian 中实际测试两台设备间的同步

## 已知问题

- `vitest` 无法运行（rollup native 模块签名问题），需要 `npm i` 重装依赖

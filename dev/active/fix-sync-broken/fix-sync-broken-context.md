# 修复同步功能 - 上下文文档

> 最后更新：2026-04-01

## 关键文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `src/transport/ws-server.ts` | 已修复（未提交） | 改为条件式 `require('ws')`，`supportsIncomingConnections()` 守卫 |
| `src/transport/ws-client.ts` | 已修复（未提交） | 条件式加载：桌面 `require('ws')`，移动端 `globalThis.WebSocket` |
| `src/transport/socket.ts` | 已修复（未提交） | `addSocketListener` 参数传递修复 |
| `src/transport/connection-manager.ts` | 代码审查通过 | 握手流程依赖 ws-client 和 socket.ts 的正确性 |
| `src/transport/protocol.ts` | 无变更 | 编解码逻辑正常 |
| `src/discovery/udp-broadcast.ts` | 待验证 | 使用 `getDynamicRequire()('dgram')`，桌面端应该可用 |
| `src/utils/network.ts` | 待验证 | 使用 `getDynamicRequire()('os')`，桌面端应该可用 |
| `src/utils/runtime.ts` | 无需修改 | `getDynamicRequire()` 和 `supportsIncomingConnections()` 逻辑正确 |
| `esbuild.config.mjs` | 无变更 | `platform: 'node'`，external 包含 builtins |

## 架构决策记录

### ADR-001：ws 包必须用条件式 require 而非静态 import（2026-04-01 更新）

- **背景**：提交 49fa042 为了 mobile 兼容，将静态 import 改为 `getDynamicRequire()('ws')`，但导致 ws 不被打包
- **第一次修复尝试**：恢复静态 `import { WebSocket } from 'ws'` — 桌面可用但 mobile 会崩溃，因为 ws 内部 `require('http')` 等会在模块初始化时执行
- **最终方案**：在运行时守卫（`canUseNodeRuntime()`/`supportsIncomingConnections()`）内使用 `require('ws')`
- **原理**：esbuild 识别 `require('ws')` 并打包 ws，但用 `__commonJS` 惰性包装器包裹。只有 `require_ws()` 被实际调用时 ws 代码才执行。在 mobile 端条件不满足，ws 代码不执行
- **验证**：非压缩构建确认 `require_ws()` 只出现在条件分支内，ws 的 `require("http")` 等在 `__commonJS` 包装器中

### ADR-002：ws-client.ts 双路径策略（2026-04-01）

- **桌面端**：`canUseNodeRuntime()` → `require('ws').WebSocket`（ws 库的 WebSocket，支持 `on`/`removeListener`，与 socket.ts 抽象层完全兼容）
- **移动端**：`globalThis.WebSocket`（浏览器原生 WebSocket，只有 `addEventListener`，通过 socket.ts 抽象层兼容）
- **socket.ts 兼容层**：`addSocketMessageListener` 已正确处理两种 API（`addEventListener` 路径提取 `event.data`，`on` 路径直接传 data）
- **注意**：移动端同步功能受限 — 不能运行 WS Server（无 Node.js），只能作为 outbound-only 客户端

## 重要发现与注意事项

### 1. esbuild external 与 ws 包的关系
- `esbuild.config.mjs` 的 external 列表包含 `builtins`（Node 内置模块如 `fs`, `http`, `dgram` 等）和 `obsidian`
- `ws` 包 **不在** external 列表中，所以 esbuild 会把它打入 bundle
- 如果用动态 `getDynamicRequire()('ws')` 加载，esbuild 不知道需要打包它，运行时就找不到
- 如果用静态 `import` 加载，esbuild 打包了但模块初始化链在 mobile 上会触发 `require('http')` 等失败
- **正确做法**：条件式 `require('ws')` — esbuild 打包 + 惰性加载
- `dgram` 和 `os` **在** builtins external 列表中，所以它们用 `getDynamicRequire()` 没问题（反正也不会被打包）

### 2. __commonJS 惰性包装器机制
- esbuild CJS 输出中，每个 bundled 模块包在 `__commonJS({ ... })` 中
- 返回一个 `require_xxx` 函数，只有被调用时模块代码才执行
- 这意味着：即使 ws 代码在 bundle 中，只要不调用 `require_ws()`，ws 的 `require('http')` 等就不会执行
- 非压缩构建验证：`require_ws()` 只在条件分支（`canUseNodeRuntime()`/`supportsIncomingConnections()` 为 true）内出现

### 3. socket.ts addSocketListener 的 bug（已修复）
- `addSocketListener` 函数中 addEventListener 路径原先：
  ```js
  const wrapped = (() => listener()) as EventListener;
  ```
  这会丢弃所有参数！error 事件的 listener 期望收到 error 对象，但实际收到的是 undefined
- 已修复为：`((...args: any[]) => listener(...args)) as EventListener`
- `addSocketMessageListener` 有独立处理（正确提取 `event.data`），不受此 bug 影响

### 4. Bundle 大小对比
- 动态 `getDynamicRequire()('ws')`（49fa042）：190KB — 缺少 ws 包
- 条件式 `require('ws')`（当前）：237KB — 正常大小，ws 已打包
- 原始版本（HEAD~1）：约 235KB

### 5. 测试环境限制
- `vitest` 因 `@rollup/rollup-darwin-arm64` 签名问题无法运行，需要重装 `node_modules`
- `globalThis.WebSocket` 在 Node.js 20 中不存在（Node 22+ 才有），但在 Electron/Obsidian 和 mobile 浏览器中存在

## 当前状态

- **已完成**：Phase 1 全部 — ws-server.ts、ws-client.ts、socket.ts 修复 + 构建验证 + 惰性加载确认
- **下一步**：Phase 2 验证辅助功能（udp-broadcast、network），然后端到端测试
- **阻塞项**：无

## 上下文恢复指引

> 给下一个会话的 Claude：
>
> 你正在修复提交 `49fa042` 引入的同步功能完全失效问题。该提交为了支持 mobile 把所有 Node 模块改为动态 require，但导致 `ws` 包不再被 esbuild 打包。
>
> **当前进度**：Phase 1 已完成，所有代码修改已完成但未提交
>
> **已完成的工作**：
> 1. `ws-server.ts`：静态 import → 条件式 `require('ws')`（在 `supportsIncomingConnections()` 守卫内）
> 2. `ws-client.ts`：`globalThis.WebSocket` → 条件式双路径（桌面用 `require('ws').WebSocket`，移动端用 `globalThis.WebSocket`）
> 3. `socket.ts`：修复 `addSocketListener` 参数丢失 bug（`() => listener()` → `(...args) => listener(...args)`）
> 4. 构建验证：237KB 正常，非压缩构建确认 ws 惰性加载正确
>
> **下一步直接做**：
> 1. 验证 `udp-broadcast.ts` 和 `network.ts` 的 `getDynamicRequire()` 在桌面端可用
> 2. 在 Obsidian 中端到端测试
> 3. 提交所有修改
>
> **关键架构决策**：
> - ws 包不在 esbuild external 中 → 必须被打包 → 不能用 `getDynamicRequire()('ws')`
> - 静态 import 导致 ws 在 bundle 加载时初始化 → mobile 崩溃 → 不能用静态 import
> - 条件式 `require('ws')` 是唯一正确方案：esbuild 打包 + `__commonJS` 惰性加载 + 运行时条件守卫

# LAN Vault Sync — Obsidian 插件

> 在局域网内实现实时、无冲突的 Vault 同步 —— 无需云服务、无需服务器、无需订阅。

在 Mac 上编辑，iPhone 上即刻看到变化。所有流量都在局域网内流转。

![Obsidian](https://img.shields.io/badge/Obsidian-v1.4.0%2B-7C3AED?logo=obsidian\&logoColor=white)
![平台](https://img.shields.io/badge/平台-桌面%20%7C%20移动-blue)
![协议](https://img.shields.io/badge/协议-MIT-green)

---

## 为什么选择 LAN Vault Sync？

大多数同步方案会把你的笔记路由到第三方服务器。LAN Vault Sync 不同：

- **零云端** —— 数据永远不会离开局域网
- **零配置** —— 设备通过 UDP 广播自动发现彼此
- **零冲突**（文本文件）—— Yjs CRDT 在字符级别合并并发编辑，与 Google Docs 同款协同技术
- **零订阅** —— 完全开源，永久免费

---

## 功能特点

| 功能 | 说明 |
|---|---|
| **实时同步** | 文件变更通过 WebSocket 在数秒内推送给所有对等节点 |
| **CRDT 文本合并** | Markdown / 文本文件使用 [Yjs](https://github.com/yjs/yjs) 在字符级别自动合并，无冲突，不丢数据 |
| **二进制文件同步** | 图片、PDF 等附件通过 SHA-256 哈希比对进行同步 |
| **自动发现** | 设备通过 UDP 广播自动找到彼此，零配置 |
| **手动添加对端** | 在广播被屏蔽的网络中，可通过 `IP:端口` 手动添加对端 |
| **二维码配对** | 生成二维码，手机扫码即可一键添加当前设备为对端，无需手动输入 IP |
| **离线友好** | 离线编辑后重新联网时自动合并变更 |
| **P2P 架构** | 每台设备地位平等，无需中心服务器 |
| **冲突备份** | 二进制文件冲突时自动备份，不丢失任何数据 |

---

## 工作原理

```
设备 A（Mac）                           设备 B（iPhone / iPad）
┌──────────────────┐  WebSocket P2P   ┌──────────────────┐
│  Obsidian        │◄────────────────►│  Obsidian        │
│  + LAN Vault Sync│   Yjs CRDT       │  + LAN Vault Sync│
└──────────────────┘   更新            └──────────────────┘
         ▲                                      ▲
         │           UDP 广播                   │
         └──────────────────────────────────────┘
                  （仅限局域网，自动发现）
```

1. 启动时，每台设备通过 UDP 广播宣告自己的存在，同时监听其他设备的广播。
2. 设备之间建立 WebSocket 连接（每个节点既是服务端也是客户端）。
3. 交换文件树元数据，请求缺失或变更的文件。
4. **文本文件**（`.md`、`.txt` 等）通过 Yjs CRDT 同步 —— 即使多端同时在离线状态下编辑，合并也会自动完成。
5. **二进制文件**（图片、PDF 等）通过 SHA-256 哈希比对同步，修改时间最新的版本胜出。

---

## 安装方法

### 通过 Obsidian 社区插件市场安装（即将上线）

1. 打开 **设置 → 社区插件 → 浏览**
2. 搜索 **LAN Vault Sync**
3. 点击 **安装**，然后点击 **启用**

### 手动安装

1. 前往 [Releases 页面](https://github.com/your-username/obsidian-lan-vault-sync/releases) 下载最新版本的 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的 Vault 中创建文件夹：`.obsidian/plugins/lan-vault-sync/`。
3. 将下载的三个文件复制到该文件夹中。
4. 在 Obsidian 中，进入 **设置 → 社区插件**，关闭**安全模式**，然后启用 **LAN Vault Sync**。

---

## 使用方法

### 快速开始

1. 在连接到**同一局域网（Wi-Fi 或以太网）的两台或多台设备**上安装插件。
2. 在每台设备上打开 Obsidian。
3. 插件会自动发现对端并在数秒内开始同步。

### 二维码配对（推荐用于手机）

这是手机端最方便的连接方式，无需手动输入 IP 地址：

1. 在**桌面设备（Mac / Windows / Linux）**上：打开 **设置 → LAN Vault Sync**，找到「**Pair with QR code**」区块，界面会显示一个二维码。
2. 在**手机 / 平板**上：用系统相机（或任意扫码工具）扫描该二维码。
3. 扫描后，手机会弹出提示打开 Obsidian，插件会询问是否与该设备配对 —— 确认后，插件会将桌面设备的 IP:端口添加为对端，并采用二维码中的**同步密钥**。

> **注意**：如果桌面有多个网卡（如同时连接了 Wi-Fi 和以太网），可通过下拉菜单选择对应的 IP 地址，再让手机扫码。

### 同步密钥

只有使用**相同同步密钥**的设备才能互相连接。每台设备首次启动时会生成随机密钥（**设置 → LAN Vault Sync → Sync Key**）。扫码配对会自动带上密钥；手动添加对端时，请在两台设备上填写同一个密钥。密钥不一致时会弹出提示。所有设备都需要升级到支持同步密钥的版本。

### 手动连接对端

自动发现使用 UDP 广播，在部分受管 Wi-Fi 网络（访客网络、企业网络）上可能被屏蔽。此时：

1. 在**设备 A** 上：打开插件设置，记下显示的 **IP 地址** 和**端口**（默认：`53712`）。
2. 在**设备 B** 上：进入 **设置 → LAN Vault Sync → 手动对端** → 填入 `192.168.x.x:53712`。
3. 也可以使用命令面板：**LAN Vault Sync: Add device by address**。

### 状态栏

插件在 Obsidian 状态栏中显示同步状态：

| 图标 | 含义 |
|---|---|
| 🔴 | 同步已禁用或未发现对端 |
| 🟡 | 正在发现对端 |
| 🟢 | 已连接，正在同步 |

### 命令面板

打开命令面板（`Cmd/Ctrl + P`）并搜索：

- **LAN Vault Sync: Turn sync on or off** —— 启动或停止同步服务
- **LAN Vault Sync: Open sync panel** —— 打开侧边栏面板，查看已连接对端和同步日志
- **LAN Vault Sync: Add device by address** —— 通过 `IP:端口` 添加对端
- **LAN Vault Sync: Open sync log** —— 打开同步日志

0.4 版改了这些命令的名字，以前给它们设的快捷键需要重新设置。

---

## 插件设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 启用同步 | 开 | 总开关 |
| 设备名称 | 自动生成 | 显示给其他对端的友好名称 |
| 端口 | `53712` | WebSocket 监听端口 |
| 忽略路径 | `.obsidian/`、`.trash/` | 不参与同步的 Glob 路径模式 |
| 同步检查间隔 | `30s` | 两次完整文件树校验之间的时间间隔 |
| 调试日志 | 关 | 将详细日志写入开发者控制台 |

---

## 技术细节

### 架构

- **拓扑**：P2P 网格 —— 每个节点运行 WebSocket 服务端，并作为客户端连接所有已知对端
- **文本同步**：[Yjs](https://github.com/yjs/yjs) CRDT + [`fast-diff`](https://github.com/jhchen/fast-diff) 计算增量
- **二进制同步**：SHA-256 哈希比对，哈希不同时传输完整文件
- **设备发现**：UDP 广播，端口 `53713`（仅限同一子网）
- **状态持久化**：Yjs 文档状态保存至 `.obsidian/plugins/lan-vault-sync/crdt-state/`，重启后保留合并历史
- **冲突备份**：被覆盖的二进制文件备份至 `.obsidian/plugins/lan-vault-sync/conflicts/`

### 冲突处理策略

| 文件类型 | 策略 |
|---|---|
| 文本（`.md`、`.txt`、`.canvas`……） | Yjs CRDT —— 自动、**无损**地在字符级别合并 |
| 二进制（图片、PDF、音频……） | 按修改时间戳取最新版本（Last-Write-Wins），旧版本自动备份 |

### 移动端兼容性

- 移动设备（iOS / Android）只能作为 WebSocket **客户端** —— 受 OS 限制无法运行服务端。
- 需要至少一台桌面设备在局域网中保持可达，作为移动端的服务端。
- 自动发现在移动端可能不可用，建议使用**二维码配对**或**手动添加对端**作为备选方案。
- 回到 Obsidian 前台后，同步会自动恢复。

### 隐私与安全

- 所有流量仅在**局域网内传输**，不向任何外部服务器发送数据。
- 只有知道同步密钥的设备才能连接；密钥本身不会在网络上传输。
- 通信内容仍是本地网络内的明文 WebSocket（`ws://`），未加密。请勿在公共或不可信网络中启用本插件。
- 无需账号，无数据收集，无遥测。

---

## 环境要求

- Obsidian **v1.4.0** 或更高版本
- 所有设备需处于**同一局域网**（同一 Wi-Fi 或以太网网段）
- 移动端同步：至少需要一台**桌面设备**在局域网中运行并可达

---

## 开发

```bash
# 克隆并安装依赖
git clone https://github.com/your-username/obsidian-lan-vault-sync
cd obsidian-lan-vault-sync
npm install

# 开发构建（watch 模式，保存后自动重新编译）
npm run dev

# 生产构建
npm run build

# 运行测试
npm test
```

在 Obsidian 中安装 **Hot Reload** 社区插件，可在每次构建后自动重载插件。

完整的多设备测试指南请参阅 [doc/debug-and-testing.md](doc/debug-and-testing.md)。

---

## 路线图

- [x] 二维码配对 —— 扫码即可添加对端（手机友好）
- [ ] 端对端加密（TLS / WireGuard）
- [ ] 逐文件同步进度显示
- [ ] 按对端选择性同步（包含/排除文件夹）
- [ ] 二进制文件冲突解决 UI
- [ ] mDNS / Bonjour 发现作为 UDP 广播的替代方案

---

## 贡献

欢迎提交 Pull Request 和 Issue。提交较大 PR 前，建议先开 Issue 说明意图。

---

## 许可证

[MIT](LICENSE)

---

## 致谢

- [Yjs](https://github.com/yjs/yjs) —— Kevin Jahns 开发的 CRDT 框架
- [ws](https://github.com/websockets/ws) —— Node.js WebSocket 库
- [fast-diff](https://github.com/jhchen/fast-diff) —— 高性能字符串差异算法
- [Obsidian](https://obsidian.md) —— 最好的本地优先知识库

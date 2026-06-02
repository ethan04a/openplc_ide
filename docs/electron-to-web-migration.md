# OpenPLC Editor：Electron 迁移至 Web 版代码变更说明

本文档记录将 **React 18 + Electron** 架构改造为 **React 18 浏览器前端 + Node.js 本地 API 服务** 时在代码层面所做的全部关键改动，供后续 AI 或开发者复用同一迁移路径。

---

## 0. 迁移复盘（`webversion` 分支）

### 0.1 做了什么

| 阶段 | 内容 | 状态 |
|------|------|------|
| **1. 通信层替换** | `preload` + `ipcRenderer` → `web-bridge.ts`（fetch + WebSocket）；`MainProcessBridge` → `ApiBridge`（Express + ws） | ✅ 完成 |
| **2. 后端服务化** | 新增 `src/server/index.ts`，复用 `src/main/` 下 compiler / hardware / modbus / simulator 等业务模块 | ✅ 完成 |
| **3. 去 Electron 化** | project-service、user-service、logger、compiler、hardware、store 等移除 `dialog` / `app.getPath` / `electron-store` | ✅ 完成 |
| **4. Renderer 适配** | 移除 TitleBar / 窗口控制逻辑；修复 `window.bridge` 模块顶层引用；CSP 与 webpack proxy | ✅ 完成 |
| **5. 构建改造** | `target: 'web'`；移除 main/preload/dll webpack；`package.json` 去掉 electron 脚本与依赖 | ✅ 完成 |
| **6. 遗留清理** | 删除 Electron 入口、打包配置、notarize/rebuild 脚本等（见 §8） | ✅ 完成 |
| **7. 端到端验证** | 清空 `node_modules` 重装 → `npm run start:dev` → 前端 1212 + API 3001 正常 | ✅ 完成 |

### 0.2 架构变化一句话

**Before：** Electron 主进程持有全部 Node 能力，通过 IPC + preload 暴露给 Renderer。  
**After：** 浏览器跑 React SPA；本地 Express 服务持有 Node 能力；两者通过 HTTP `/api/invoke|send` 与 WebSocket `/api/ws` 通信。

### 0.3 关键 Bug 与修复（迁移过程中实际遇到）

| 现象 | 根因 | 修复 |
|------|------|------|
| 首页空白 / CSP 报错 | 开发环境 webpack 需要 `eval`，CSP 过严 | `index.ejs` 开发 CSP 加 `unsafe-eval`、`ws:`/`wss:` |
| `process is not defined` | `web-bridge.ts` 使用 `process.env.API_BASE` | 改为 `const API_BASE = ''`（同源 + dev proxy） |
| `fileWatchStopAll` 为 undefined | `shared/index.ts` 模块顶层 `const x = window.bridge` | 改为 `import { bridge } from '@root/platform'`（monaco 同理） |
| `EADDRINUSE :1212` | 旧 webpack 进程未退出 | 释放 1212/3001 端口后重启 |
| `node scripts/clean.js` 失败 | 脚本 import 了 `.ts` 版 `webpack.paths` | 改为内联路径，不依赖 ts-node |

### 0.4 验证结果（2026-06-02，Windows x64）

```text
npm install                          → postinstall 下载二进制成功
npm run start:dev                    → api:3001 + web:1212 同时启动
GET  http://localhost:1212/          → 200
GET  http://localhost:1212/renderer.dev.js → 200（Monaco 首次编译约 1–2 分钟）
POST http://localhost:3001/api/invoke/system:get-system-info → 200
POST http://localhost:1212/api/invoke/system:get-system-info → 200（proxy 正常）
npm run build:renderer               → 生产构建通过
```

`src/` 内已无 `from 'electron'` 引用（仅剩注释中的 "electron" 字样）。

### 0.5 仍待后续处理（非阻塞 Web 运行）

| 项 | 说明 |
|----|------|
| `.github/workflows/release.yml` | 仍含 `electron-builder` 步骤，需改为 web 打包/部署流程 |
| `CLAUDE.md` / `README.md` | 架构描述仍偏 Electron，需同步 |
| `docs/call-chains/*.md` | 历史调用链文档，引用已删的 `main.ts` / preload |
| `e2e/example.spec.ts` | 已删除；`playwright.config.ts` 保留，可后续写浏览器 E2E |
| `window-controls` 组件 | UI 仍存在但 bridge 侧为 no-op，可逐步移除 |
| Renderer 中 `window.bridge` | 约 24 个文件仍用运行时访问；新代码建议统一 `import { bridge } from '@root/platform'` |
| `package-lock.json`  transitive | 部分 dev 依赖仍间接引用 `electron`（如 `@playwright/test` 可选 peer），根 `package.json` 已无 electron 直接依赖 |

---

## 1. 迁移目标与架构对比

### 1.1 原架构（Electron）

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                        │
│  ├── BrowserWindow / Menu / nativeTheme                 │
│  ├── ipcMain.handle / ipcMain.on                        │
│  ├── ProjectService / Compiler / Modbus / Simulator     │
│  └── preload.ts → contextBridge.exposeInMainWorld         │
└───────────────────────────┬─────────────────────────────┘
                            │ IPC (invoke / send / MessageChannel)
┌───────────────────────────▼─────────────────────────────┐
│  Renderer (React 18) — window.bridge                      │
└─────────────────────────────────────────────────────────┘
```

### 1.2 目标架构（Web）

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React 18 SPA)                                 │
│  ├── src/platform/web-bridge.ts（替代 preload）         │
│  ├── fetch → /api/invoke/:channel                       │
│  ├── fetch → /api/send/:channel                         │
│  └── WebSocket → /api/ws（编译流 + 服务端推送事件）      │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP / WebSocket（dev 经 webpack proxy）
┌───────────────────────────▼─────────────────────────────┐
│  Node.js API Server (Express + ws)                      │
│  ├── src/server/index.ts                                │
│  └── ApiBridge（由原 MainProcessBridge 重构）             │
│      └── 复用 src/main/services、compiler、hardware 等   │
└─────────────────────────────────────────────────────────┘
```

### 1.3 核心设计原则

1. **保持 `window.bridge` API 契约不变**：Renderer 中原有大量 `window.bridge.*` 调用尽量不改签名，降低 UI 层改动量。
2. **Main 进程业务能力下沉为 Node 服务**：编译、文件系统、Modbus、模拟器等无法进浏览器的逻辑保留在 `src/main/`，由 HTTP/WebSocket 暴露。
3. **不是纯静态 SPA**：仍需本地 Node 进程；无法部署到无后端的 CDN。
4. **模块顶层禁止依赖 `window.bridge`**：必须在 `index.tsx` 注入后才能安全使用的场景，改用 `import { bridge } from '@root/platform'`。

---

## 2. 新增文件清单

| 路径 | 职责 |
|------|------|
| `src/platform/web-bridge.ts` | 浏览器端 bridge 实现：`fetch` + `WebSocket` + 内存事件总线 |
| `src/platform/index.ts` | 导出 `bridge`、`initWebBridge`；声明 `Window.bridge` 类型 |
| `src/server/index.ts` | Express 入口：注册路由、静态资源、WebSocket |
| `src/server/event-bus.ts` | 服务端 → 客户端事件推送（替代 `webContents.send`） |
| `src/shared/platform/paths.ts` | 替代 `app.getPath('userData')` / `process.resourcesPath` |
| `src/shared/platform/json-serialization.ts` | IPC 参数序列化（`Map`、`Uint8Array` 等） |
| `src/shared/platform/compile-stream-port.ts` | 编译流抽象（替代 Electron `MessagePortMain`） |
| `src/main/utils/native-folder-picker.ts` | 替代 `dialog.showOpenDialog`（Windows/macOS/Linux） |
| `src/main/modules/store/file-store.ts` | 替代 `electron-store` 的 JSON 文件存储 |
| `src/types/IPC/save-data.ts` | 从已删除的 `ipc/renderer.ts` 抽离的共享类型 |
| `configs/webpack/webpack.config.renderer.base.ts` | Web 专用 webpack base（无 electron externals） |

---

## 3. 主进程 IPC 层重构

### 3.1 `MainProcessBridge` → `ApiBridge`

**文件：** `src/main/modules/ipc/main.ts`（保留路径，内容已重构）

| 变更项 | 说明 |
|--------|------|
| 类名 | `MainProcessBridge` 重命名为 `ApiBridge` |
| 移除依赖 | `ipcMain`、`BrowserWindow`、`nativeTheme`、`shell`、`app` |
| 事件推送 | `mainWindow.webContents.send(...)` → `serverEventBus.emitEvent(channel, ...args)` |
| 路由注册 | 新增 `registerHttpRoutes(app: Express)` |
| 编译流 | 新增 `handleWebSocketMessage(socket, payload)`，使用 `WebSocketCompileStreamPort` |
| Handler 签名 | 去掉 `_event: IpcMainInvokeEvent` 首参，改为直接业务参数 |

**HTTP 路由约定：**

```
POST /api/invoke/:channel   body: { args: [...] }  → 原 ipcMain.handle
POST /api/send/:channel     body: { args: [...] }  → 原 ipcRenderer.send
WebSocket /api/ws           → 编译流 + 服务端事件订阅
```

**`dispatchInvoke` 需覆盖的原 IPC channel（完整列表见原 `setupMainIpcListener`）：**

- Project: `project:create`, `project:open`, `project:path-picker`, `project:save`, `project:save-file`, `project:open-by-path`
- POU: `pou:create`, `pou:delete`, `pou:rename`
- System: `open-external-link`, `system:get-system-info`, `app:store-retrieve-recent`
- Compiler: `compiler:export-project-xml`（invoke）；`compiler:run-compile-program`、`compiler:run-debug-compilation`（WebSocket）
- Hardware / Util / Debugger / Runtime / Simulator / FileWatcher：与原 IPC 一一对应

### 3.2 服务端入口

**文件：** `src/server/index.ts`

```typescript
// 启动顺序
new UserService()
const apiBridge = new ApiBridge({ projectService, pouService, compilerModule, hardwareModule })
apiBridge.registerHttpRoutes(app)
// 生产环境：express.static(release/app/dist/renderer) + SPA fallback
// WebSocket：serverEventBus 转发 + handleWebSocketMessage 处理编译
server.listen(API_PORT) // 默认 3001
```

---

## 4. 浏览器端 Bridge 实现

### 4.1 `src/platform/web-bridge.ts`

实现与原 `src/main/modules/ipc/renderer.ts`（已删除）同名方法，通信方式映射如下：

| 原 Electron 机制 | Web 实现 |
|------------------|----------|
| `ipcRenderer.invoke(channel, ...args)` | `fetch('/api/invoke/' + channel, { body: { args } })` |
| `ipcRenderer.send(channel, ...args)` | `fetch('/api/send/' + channel, { body: { args } })` |
| `ipcRenderer.on(channel, cb)` | 内存 `Map<channel, Set<callback>>` + WebSocket 事件 |
| `MessageChannel` 编译流 | WebSocket 发送 `{ type: 'compiler:run-*', args }`，接收 `{ type: 'compile-message', data }` |
| `shell.openExternal(url)` | `window.open(url, '_blank')` |
| 窗口控制（minimize/maximize/close） | 空操作 no-op |
| `dialog.showSaveDialog`（导出 XML） | 后端生成内容，前端 `Blob` + `<a download>` |

**关键实现细节：**

```typescript
// 必须使用同源相对路径，禁止在浏览器中访问 process.env
const API_BASE = ''
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`

// 快捷键：document.addEventListener('keydown', ...) 映射到 emit(channel)
// initWebBridge()：建立 WebSocket 连接
```

### 4.2 Renderer 入口注入

**文件：** `src/renderer/index.tsx`

```typescript
import { bridge, initWebBridge } from '@root/platform'

initWebBridge()
window.bridge = bridge
// 然后 createRoot(...).render(<App />)
```

---

## 5. Main 层服务去 Electron 化

以下文件将 `electron` API 替换为 Node/平台工具：

| 文件 | 原依赖 | 替换方案 |
|------|--------|----------|
| `src/main/services/project-service/index.ts` | `dialog.showOpenDialog`, `BrowserWindow`, `app.getPath` | `pickNativeFolder()`, 去掉构造函数参数, `getUserDataPath()` |
| `src/main/services/user-service/index.ts` | `app.getPath('userData')` | `getUserDataPath()` |
| `src/main/services/logger-service/index.ts` | `app.getPath('userData')` | `getUserDataPath()` + `logPath` |
| `src/main/modules/compiler/compiler-module.ts` | `electronApp`, `dialog`, `MessagePortMain` | `getUserDataPath()`, 导出改浏览器下载, `CompileStreamPort` |
| `src/main/modules/hardware/hardware-module.ts` | `electronApp.getPath`, `process.resourcesPath` | `getUserDataPath()`, `getResourcesPath()` |
| `src/main/modules/store/index.ts` | `electron-store` | `file-store.ts`（JSON 持久化） |
| `src/main/utils/path-picker.ts` | `dialog.showOpenDialog` | `native-folder-picker.ts` |

**用户数据目录（跨平台）：** 见 `src/shared/platform/paths.ts`  
Windows: `%APPDATA%/open-plc-editor`  
macOS: `~/Library/Application Support/open-plc-editor`  
Linux: `~/.config/open-plc-editor`

---

## 6. Renderer UI 层适配

### 6.1 必须修改的文件

| 文件 | 改动 |
|------|------|
| `src/renderer/components/_templates/app-layout.tsx` | 移除 `TitleBar`、Electron 窗口标题栏逻辑；布局改为 `inset-0` 全屏 |
| `src/renderer/components/_templates/accelerator-handler.tsx` | 简化 `beforeunload`；移除 macOS `hideWindow` 等 Electron 退出流程 |
| `src/renderer/index.ejs` | **开发环境 CSP** 增加 `unsafe-eval`（webpack 需要）、`ws:`/`wss:`（WebSocket） |
| `src/renderer/store/slices/shared/index.ts` | **禁止** 模块顶层 `const x = window.bridge`；改为 `import { bridge } from '@root/platform'` |
| `src/renderer/components/.../monaco/index.tsx` | 同上；移除 `import type { IpcRendererEvent } from 'electron'` |
| `src/types/IPC/save-data.ts` | 新建；`shared/index.ts` 不再从 `ipc/renderer.ts` 导入类型 |

### 6.2 仍使用 `window.bridge` 的文件

以下文件在 **运行时**（useEffect / 事件回调内）访问 `window.bridge`，在 `index.tsx` 注入后可用，**无需改为 import**，但新代码建议统一 `import { bridge } from '@root/platform'`：

```bash
rg "window\.bridge" src/renderer
```

典型文件：`accelerator-handler.tsx`、`workspace-screen.tsx`、`use-compiler.ts`、各 menu-bar / modals 等。

### 6.3 禁止模式（常见 Bug）

```typescript
// ❌ 错误：模块加载时 window.bridge 尚未赋值
const fileBridge = window.bridge

// ✅ 正确：从 platform 模块直接导入
import { bridge } from '@root/platform'
void bridge.fileWatchStopAll()
```

```typescript
// ❌ 错误：Webpack 5 浏览器 bundle 中 process 不存在
const API_BASE = process.env.API_BASE || ''

// ✅ 正确：使用同源路径，由 devServer proxy 转发
const API_BASE = ''
```

---

## 7. 构建与工程配置

### 7.1 `package.json` scripts（当前）

```json
{
  "build": "npm run build:renderer",
  "build:renderer": "webpack --config ./configs/webpack/webpack.config.renderer.prod.ts",
  "start": "ts-node -r tsconfig-paths/register src/server/index.ts",
  "start:dev": "concurrently -k -n api,web \"npm run start:server\" \"npm run start:renderer\"",
  "start:server": "cross-env NODE_ENV=development ts-node -r tsconfig-paths/register src/server/index.ts",
  "start:renderer": "webpack serve --config ./configs/webpack/webpack.config.renderer.dev.ts",
  "postinstall": "ts-node scripts/download-binaries.ts"
}
```

**已移除的脚本：** `start:main`, `start:preload`, `build:main`, `build:dll`, `package`, `rebuild`  
**已移除的直接依赖：** `electron`, `electron-builder`, `electron-store`, `electron-updater`, `electron-log`, `electron-debug`, `@electron/notarize` 等  
**新增依赖：** `express`, `ws`；`serialport` 在根 `dependencies`（Modbus RTU 后端）

### 7.2 Webpack（当前保留的配置）

| 文件 | 职责 |
|------|------|
| `webpack.config.renderer.dev.ts` | 开发：`target: 'web'`；HMR；`proxy: ['/api'] → localhost:3001`；**无 DLL** |
| `webpack.config.renderer.prod.ts` | 生产：`target: 'web'`；输出到 `release/app/dist/renderer` |
| `webpack.config.renderer.base.ts` | 公共 ts-loader / resolve 配置 |
| `webpack.paths.ts` | 精简后仅保留 web 相关路径（`distRendererPath` 等） |
| `webpack.app-info.ts` | 版本信息 DefinePlugin |

**生产静态资源路径：** `release/app/dist/renderer/`（由 `webpack.paths.ts` 的 `distRendererPath` 决定；`release/app/package.json` 已删除，该目录仅作构建输出）

### 7.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "outDir": "dist"
  },
  "exclude": ["test", "release/build", "release/app/dist", "dist"]
}
```

Electron 入口文件已物理删除，不再需要在 `exclude` 中单独列出。

### 7.4 其他工程文件变更

| 文件 | 变更 |
|------|------|
| `jest.config.json` | `moduleDirectories` 去掉 `release/app/node_modules` |
| `eslint.config.mjs` | ignore `dist/**` 替代 `configs/dll/**` |
| `.gitignore` | 移除 `configs/dll`；保留 `release/app/dist` |
| `scripts/clean.js` | 清理 `release/app/dist` 与 `dist`（纯 Node，不 import `.ts`） |
| `scripts/delete-source-maps.js` | 仅清理 renderer 产物 map |

---

## 8. 已删除的 Electron 遗留文件

以下文件**已从仓库移除**，不再参与任何构建：

### 8.1 源码

| 路径 | 原职责 |
|------|--------|
| `src/main/main.ts` | Electron 主进程入口 |
| `src/main/menu.ts` | 原生菜单与快捷键 |
| `src/main/modules/ipc/renderer.ts` | preload 侧 bridge（Renderer 禁止再 import） |
| `src/main/modules/preload/` | preload 脚本与 splash 页面 |
| `src/main/utils/resolve-html-path.ts` | `BrowserWindow.loadURL` 路径解析 |
| `src/main/contracts/types/modules/ipc/main.ts` | `MainIpcModule` 类型（依赖 MenuBuilder） |
| `src/main/contracts/types/child-window.ts` | BrowserWindow 配置 schema（已无引用） |

### 8.2 Webpack / 打包

| 路径 |
|------|
| `configs/webpack/webpack.config.main.dev.ts` |
| `configs/webpack/webpack.config.main.prod.ts` |
| `configs/webpack/webpack.config.preload.dev.ts` |
| `configs/webpack/webpack.config.renderer.dev.dll.ts` |
| `configs/webpack/webpack.config.base.ts` |
| `electron-builder.json` |

### 8.3 脚本与发布结构

| 路径 | 原职责 |
|------|--------|
| `scripts/notarize.js` | macOS 公证 |
| `scripts/electron-rebuild.js` | native 模块重编译 |
| `scripts/check-native-dep.js` | electron-builder 依赖检查 |
| `scripts/link-modules.ts` | release/app node_modules 软链 |
| `scripts/check-build-exists.ts` | 检查 main/renderer bundle |
| `release/app/package.json` | Electron 子包（serialport 已移至根 package.json） |
| `release/app/package-lock.json` | 同上 |

### 8.4 测试 / Mock

| 路径 |
|------|
| `e2e/example.spec.ts`（Electron Playwright 启动测试） |
| `configs/mocks/example-package.json`（旧 Electron package.json 快照） |

---

## 9. 运行方式

### 9.1 开发

```bash
npm install
npm run start:dev
```

| 服务 | 地址 |
|------|------|
| 前端（webpack-dev-server） | http://localhost:1212 |
| 后端 API | http://localhost:3001 |
| API 代理 | 前端 `/api/*` → `3001` |

首次编译含 Monaco Editor，约需 1–2 分钟；webpack 可能长时间无 “compiled” 字样，但 bundle 已可访问。

### 9.2 生产

```bash
npm run build:renderer
npm start   # NODE_ENV=production，同时提供静态文件 + API
```

访问 http://localhost:3001

### 9.3 完整清理后重装（推荐验证流程）

**Windows PowerShell：**

```powershell
# 1. 释放端口
Get-NetTCPConnection -LocalPort 1212,3001 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# 2. 清理构建产物
node scripts/clean.js
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue

# 3. 重装并启动
npm install
npm run start:dev
```

**快速健康检查：**

```powershell
Invoke-WebRequest http://localhost:1212/ -UseBasicParsing
Invoke-WebRequest http://localhost:3001/api/invoke/system:get-system-info `
  -Method POST -Body '{}' -ContentType 'application/json' -UseBasicParsing
```

### 9.4 端口占用处理（Windows）

```powershell
Get-NetTCPConnection -LocalPort 1212,3001 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
npm run start:dev
```

---

## 10. 功能对照与已知限制

| 功能 | Electron 实现 | Web 实现 | 状态 |
|------|---------------|----------|------|
| 项目打开/保存 | 原生目录对话框 | OS 脚本选目录（PowerShell/osascript/zenity） | ✅ |
| 编译输出流 | MessageChannel | WebSocket | ✅ |
| 文件监视 | fs.watchFile + IPC 推送 | 同左，经 serverEventBus 推送 | ✅ |
| 导出 XML | showSaveDialog | 浏览器下载 | ✅ |
| 快捷键 | 原生 Menu accelerator | `keydown` 监听 + web-bridge emit | ✅ 部分 |
| 窗口控制/标题栏 | BrowserWindow | 已移除 / bridge no-op | N/A |
| 自动更新 | electron-updater | 无 | ❌ |
| 外部链接 | shell.openExternal | window.open | ✅ |
| 桌面打包 | electron-builder | 未实现（需 Docker/pkg 等方案） | ❌ |

---

## 11. AI 复现迁移检查清单

按顺序执行（`webversion` 分支已全部完成）：

- [x] **1. 新建** `src/platform/web-bridge.ts`，完整实现原 `renderer.ts` 的 public API
- [x] **2. 新建** `src/server/index.ts` + `src/server/event-bus.ts`
- [x] **3. 重构** `src/main/modules/ipc/main.ts` → `ApiBridge`，注册 HTTP/WS 路由
- [x] **4. 新建** `src/shared/platform/*`（paths、serialization、compile-stream-port）
- [x] **5. 去 Electron 化** project-service、user-service、compiler、hardware、store
- [x] **6. 新建** `native-folder-picker.ts`；compiler 导出改为返回 content + 前端 download
- [x] **7. 抽离** `src/types/IPC/save-data.ts`，Renderer 禁止 import `ipc/renderer.ts`
- [x] **8. 修改** `src/renderer/index.tsx` 注入 bridge；**shared/monaco 必须用 import bridge**
- [x] **9. 修改** webpack：`target: 'web'`，devServer proxy，新 base config
- [x] **10. 修改** `index.ejs` CSP（开发环境 `unsafe-eval` + ws）
- [x] **11. 修改** `package.json`：移除 electron 脚本/依赖，添加 express/ws/concurrently
- [x] **12. 删除** Electron 入口、preload、main/preload webpack、electron-builder 等（§8）
- [x] **13. 适配 UI**：移除 TitleBar/window-controls 依赖；简化 beforeunload
- [x] **14. 验证**：清空 node_modules 重装 → start:dev → API/前端 HTTP 200

**可选后续：**

- [ ] 更新 `.github/workflows/release.yml` 为 web 部署
- [ ] 同步 `CLAUDE.md` / `README.md`
- [ ] 编写浏览器 Playwright E2E（替代已删 Electron E2E）
- [ ] 全局将 `window.bridge` 替换为 `import { bridge }`

---

## 12. 调试常见问题

| 现象 | 原因 | 修复 |
|------|------|------|
| `process is not defined` | 浏览器代码访问 `process.env` | 改用常量或 webpack `DefinePlugin` 仅注入 `NODE_ENV` |
| `Cannot read properties of undefined (reading 'fileWatchStopAll')` | 模块顶层缓存 `window.bridge` | 改为 `import { bridge } from '@root/platform'` |
| 页面空白，控制台 CSP 报错 | 开发环境禁止 `eval` | `index.ejs` 开发 CSP 加 `unsafe-eval` |
| `EADDRINUSE :1212` | 旧 webpack 进程未退出 | 释放端口后重启 |
| webpack 长时间无 compiled 提示 | Monaco 首次编译慢 | 正常，等待 1–2 分钟；可 curl `renderer.dev.js` 确认 |
| API 404 on `/api/health` | 无 health 路由 | 使用 `POST /api/invoke/system:get-system-info` 验证 |
| API 404 on other routes | 后端未启动或 proxy 未配置 | 确认 `start:server` 运行且 devServer proxy `/api` |
| `node scripts/clean.js` 报 MODULE_NOT_FOUND | 旧版 import `.ts` paths | 使用当前版 `clean.js`（内联路径） |

---

## 13. 相关文件索引（快速 grep）

```bash
# Renderer 中所有 bridge 调用
rg "window\.bridge" src/renderer

# 确认无 electron import（应无结果）
rg "from 'electron'" src

# ApiBridge 路由注册
rg "dispatchInvoke|registerHttpRoutes" src/main/modules/ipc/main.ts

# 平台 bridge 导出
rg "export default webBridge|initWebBridge" src/platform

# 当前 webpack 配置（应只剩 renderer.*）
ls configs/webpack/
```

---

## 14. 目录结构速览（迁移后）

```
src/
├── platform/           # web-bridge（浏览器 API 客户端）
├── server/             # Express + WebSocket 入口
├── shared/platform/    # paths、序列化、编译流端口
├── main/               # 业务逻辑（compiler、services、modbus…）— 无 Electron 入口
│   └── modules/ipc/main.ts   # ApiBridge
└── renderer/           # React 18 SPA

configs/webpack/
├── webpack.config.renderer.dev.ts
├── webpack.config.renderer.prod.ts
├── webpack.config.renderer.base.ts
├── webpack.paths.ts
└── webpack.app-info.ts

release/app/dist/renderer/   # 生产构建输出（gitignore）
```

---

*文档版本：基于 `webversion` 分支迁移实践整理（含 Electron 遗留清理与重装验证）。*  
*适用项目：OpenPLC Editor 4.1.4（React 18 + TypeScript + Zustand + Webpack 5 + Express + ws）。*  
*最后更新：2026-06-02*

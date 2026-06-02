# 01. Electron 启动到界面渲染调用链

本文说明 OpenPLC Editor 从 Electron 应用启动，到 React 界面渲染，再到页面切换、Tab 切换、弹窗挂载的完整链路。

## 1. 总览

这个项目不是传统 Web SPA 的路由结构，没有使用 `react-router`。它的页面切换主要靠 Zustand 全局状态驱动：

```text
Electron app ready
  -> 创建 BrowserWindow
  -> 加载 renderer/index.html
  -> preload 暴露 window.bridge
  -> renderer/index.tsx 挂载 React
  -> App.tsx 根据 project.meta.path 决定 StartScreen 或 WorkspaceScreen
  -> WorkspaceScreen 内部再根据 tabs/editor/modals 状态决定具体编辑器和弹窗
```

核心判断：

```tsx
path === '' ? <StartScreen /> : <WorkspaceScreen />
```

也就是说，应用首次打开时一定先进入启动页。创建或打开项目后，`project.meta.path` 被写入，React 重新渲染为工作区。

## 2. Electron 主进程启动链路

入口文件：

```text
src/main/main.ts
```

启动链路：

```text
app.whenReady()
  -> createMainWindow()
    -> 创建 splash BrowserWindow
    -> splash.loadFile(...)
    -> 创建 mainWindow BrowserWindow，show: false
    -> mainWindow.loadURL(resolveHtmlPath('index.html'))
    -> mainWindow.once('ready-to-show')
       -> maximize/minimize
       -> 延迟关闭 splash
       -> mainWindow.show()
    -> 初始化 MenuBuilder
    -> 初始化 ProjectService
    -> 初始化 PouService
    -> 初始化 CompilerModule
    -> 初始化 HardwareModule
    -> new MainProcessBridge(...)
    -> setupMainIpcListener()
```

主窗口创建点：

```ts
mainWindow = new BrowserWindow({
  minWidth: 1124,
  minHeight: 628,
  show: false,
  icon: getAssetPath('icon.png'),
  ...titlebarStyles,
  webPreferences: {
    sandbox: true,
    preload: app.isPackaged
      ? join(__dirname, 'preload.js')
      : join(__dirname, '../../configs/dll/preload.js'),
  },
})
```

这里有两个窗口：

```text
splash
  -> 先加载 src/main/modules/preload/splash-screen/splash.html
  -> ready-to-show 后显示

mainWindow
  -> 先隐藏加载 renderer
  -> ready-to-show 后 3 秒关闭 splash，显示主窗口
```

这就是为什么应用启动时先出现 splash，再出现主界面。

## 3. HTML 加载链路

HTML 路径解析在：

```text
src/main/utils/resolve-html-path.ts
```

逻辑：

```text
development
  -> http://localhost:1212/index.html

production
  -> file://.../renderer/index.html
```

开发环境下，Webpack Dev Server 提供 renderer 页面。生产环境下，Electron 直接加载打包后的 HTML 文件。

HTML 模板在：

```text
src/renderer/index.ejs
```

模板里提供 React 挂载根节点：

```html
<div class="h-full bg-neutral-50 text-gray-500 dark:bg-neutral-950 dark:text-gray-400" id="root"></div>
```

Renderer 入口拿到这个 `#root` 后挂载 React。

## 4. Preload 和 IPC Bridge 链路

Preload 文件：

```text
src/main/modules/preload/preload.ts
```

核心代码：

```ts
contextBridge.exposeInMainWorld('bridge', rendererProcessBridge)
```

这一步把 renderer IPC API 安全暴露为：

```ts
window.bridge
```

Renderer 里所有主进程能力几乎都从 `window.bridge` 进入，例如：

```text
window.bridge.openProject()
window.bridge.createProject(...)
window.bridge.saveProject(...)
window.bridge.runCompileProgram(...)
window.bridge.runtimeLogin(...)
window.bridge.debuggerConnect(...)
```

Renderer 侧 bridge 定义在：

```text
src/main/modules/ipc/renderer.ts
```

主进程 IPC 监听注册在：

```text
src/main/modules/ipc/main.ts
```

对应关系示例：

```text
renderer: window.bridge.openProject()
  -> ipcRenderer.invoke('project:open')
  -> main: ipcMain.handle('project:open', this.handleProjectOpen)
  -> ProjectService.openProject()
```

## 5. React 渲染入口

入口文件：

```text
src/renderer/index.tsx
```

调用链：

```text
index.tsx
  -> import '@utils/i18n'
  -> import App
  -> document.getElementById('root')
  -> createRoot(container)
  -> root.render(<App />)
  -> postMessage({ payload: 'removeLoading' }, '*')
```

这一步只是挂载应用，没有页面选择逻辑。页面选择在 `App.tsx`。

## 6. App 级页面选择

文件：

```text
src/renderer/App.tsx
```

核心代码：

```tsx
const {
  project: {
    meta: { path },
  },
} = useOpenPLCStore()

return <AppLayout>{path === '' ? <StartScreen /> : <WorkspaceScreen />}</AppLayout>
```

状态来源：

```text
src/renderer/store/index.ts
  -> createWorkspaceSlice
  -> createEditorSlice
  -> createTabsSlice
  -> createProjectSlice
  -> createModalSlice
  -> createDeviceSlice
  -> ...
```

初始 `project.meta.path` 在：

```text
src/renderer/store/slices/project/slice.ts
```

初始值：

```ts
project: {
  meta: {
    name: '',
    type: 'plc-project',
    path: '',
  },
  ...
}
```

所以首次渲染一定是 `StartScreen`。

## 7. 首屏 StartScreen 渲染

文件：

```text
src/renderer/screens/start-screen.tsx
```

StartScreen 的界面由两个模板区域组成：

```text
StartSideContent
  -> 左侧菜单
     -> New Project
     -> Open
     -> Tutorials
     -> Exit

StartMainContent
  -> ProjectFilterBar
  -> DisplayRecentProjects
```

首次进入 StartScreen 时会做两件异步初始化：

```text
useEffect #1
  -> window.bridge.retrieveRecent()
  -> workspaceActions.setRecent(...)

useEffect #2
  -> window.bridge.getAvailableCommunicationPorts()
  -> deviceActions.setAvailableOptions({ availableCommunicationPorts })
```

启动页上的几个动作：

```text
New Project
  -> modalActions.openModal('create-project', null)

Open
  -> sharedWorkspaceActions.openProject()

Exit
  -> window.bridge.handleCloseOrHideWindow()
```

## 8. 创建项目后如何跳到 WorkspaceScreen

触发链路：

```text
StartScreen 点击 New Project
  -> openModal('create-project')
  -> AppLayout 渲染 ProjectModal
  -> ProjectModal 三步表单
  -> sharedWorkspaceActions.createProject(data)
  -> window.bridge.createProject(data)
  -> ipcMain project:create
  -> ProjectService.createProject(data)
  -> createProjectDefaultStructure(...)
  -> 返回项目数据
  -> projectActions.setProject(...)
  -> project.meta.path = dataToCreateProjectFile.path
  -> App.tsx 重新渲染
  -> path !== ''
  -> WorkspaceScreen
```

关键文件：

```text
src/renderer/components/_features/[start]/new-project/project-modal.tsx
src/renderer/components/_features/[start]/new-project/steps/*.tsx
src/renderer/store/slices/shared/index.ts
src/main/services/project-service/index.ts
src/main/services/project-service/utils/create-project.ts
```

`ProjectModal` 本身不负责跳转。它只负责表单流程和关闭弹窗。真正让页面切换的是 `createProject` 成功后写入 `project.meta.path`。

## 9. 打开已有项目后如何跳到 WorkspaceScreen

触发链路：

```text
StartScreen 点击 Open
  -> sharedWorkspaceActions.openProject()
  -> clearStatesOnCloseProject()
  -> window.bridge.openProject()
  -> ipcRenderer.invoke('project:open')
  -> MainProcessBridge.handleProjectOpen()
  -> ProjectService.openProject()
  -> dialog.showOpenDialog({ properties: ['openDirectory'] })
  -> readProjectFiles(directoryPath)
  -> 返回 project/pous/deviceConfiguration/devicePinMapping
  -> sharedWorkspaceActions.handleOpenProjectRequest(data)
  -> projectActions.setProject({ meta.path: data.meta.path, data })
  -> projectActions.setPous(pous)
  -> 初始化 ladderFlows/fbdFlows/library/files/tabs/editor
  -> App.tsx 重新渲染 WorkspaceScreen
```

打开项目后会默认打开 `main` 程序：

```text
handleOpenProjectRequest
  -> const mainPou = pous.find(name === 'main' && type === 'program')
  -> CreateEditorObjectFromTab(mainPou)
  -> editorActions.addModel(model)
  -> editorActions.setEditor(model)
  -> tabsActions.updateTabs(tab)
  -> tabsActions.setSelectedTab('main')
  -> workspaceActions.setSelectedProjectTreeLeaf(...)
```

所以打开项目后的第一工作区界面通常是 `main` 的编辑器，而不是空白工作区。

## 10. AppLayout 的职责

文件：

```text
src/renderer/components/_templates/app-layout.tsx
```

AppLayout 包住 StartScreen 和 WorkspaceScreen。它负责：

```text
1. 判断系统平台，非 Linux 时显示自定义 TitleBar
2. 通过 window.bridge.getSystemInfo() 初始化系统配置
3. 通过 window.bridge.retrieveRecent() 初始化最近项目
4. 渲染 children
5. 挂载 Toaster
6. 挂载全局弹窗
7. 挂载 AcceleratorHandler
```

全局弹窗条件渲染：

```text
modals['create-project'].open
  -> ProjectModal

modals['save-changes-project'].open
  -> SaveChangesModal

modals['save-changes-file'].open
  -> SaveChangesFileModal

modals['quit-application'].open
  -> QuitApplicationModal

modals['confirm-delete-element'].open
  -> ConfirmDeleteElementModal
```

这些弹窗不靠路由，不靠 portal manager 统一组件，而是由 AppLayout 读 Zustand modal slice 后条件渲染。

## 11. WorkspaceScreen 的渲染结构

文件：

```text
src/renderer/screens/workspace-screen.tsx
```

大结构：

```text
WorkspaceScreen
  -> AboutModal
  -> ConfirmDeviceSwitchModal
  -> RuntimeConnectionLostModal
  -> RuntimeCreateUserModal
  -> RuntimeLoginModal
  -> DebuggerMessageModal
  -> DebuggerIpInputModal
  -> WorkspaceSideContent
     -> WorkspaceActivityBar
  -> WorkspaceMainContent
     -> ResizablePanelGroup horizontal
        -> Explorer
        -> workspacePanel
           -> Navigation, 当 tabs.length > 0
           -> editorPanel
           -> consolePanel
```

工作区首次进入时还会：

```text
useRuntimePolling()
  -> runtime connected 时轮询 runtime 状态和日志

useEffect getAvailableBoards
  -> window.bridge.getAvailableBoards()
  -> deviceActions.setAvailableOptions({ availableBoards })

useEffect switchPerspective
  -> window.bridge.switchPerspective(...)

useEffect onRuntimeTokenRefreshed
  -> runtime token 刷新后更新 store
```

## 12. Workspace 内部编辑器选择链路

WorkspaceScreen 内部不是按 URL 选编辑器，而是按 `editor.type` 条件渲染：

```text
editor.type === 'plc-resource'
  -> ResourcesEditor

editor.type === 'plc-device'
  -> DeviceEditor

editor.type === 'plc-datatype'
  -> DataTypeEditor

editor.type === 'plc-server' && protocol === 'modbus-tcp'
  -> ModbusServerEditor

editor.type === 'plc-server' && protocol === 's7comm'
  -> S7CommServerEditor

editor.type === 'plc-server' && protocol === 'opcua'
  -> OpcUaServerEditor

editor.type === 'plc-remote-device'
  -> RemoteDeviceEditor

editor.type === 'plc-textual'
  -> VariablesEditor + MonacoEditor

editor.type === 'plc-graphical'
  -> VariablesEditor + GraphicalEditor
```

如果 `tabs.length === 0`：

```text
No tabs open
```

所以界面核心切换状态是两个：

```text
tabs
editor
```

## 13. Explorer 点击文件到编辑器渲染

Explorer 项目树文件：

```text
src/renderer/components/_organisms/explorer/project.tsx
```

点击树节点：

```text
ProjectTreeLeaf.onClick
  -> handleCreateTab(data)
  -> sharedWorkspaceActions.openFile(data)
```

示例：

```text
点击 program/main
  -> openFile({
       name: 'main',
       path: '/pous/programs/main.json',
       elementType: { type: 'program', language: data.language }
     })
```

`openFile` 在：

```text
src/renderer/store/slices/shared/index.ts
```

它会根据 `TabsProps.elementType` 创建或恢复 editor model：

```text
openFile
  -> CreateEditorObjectFromTab(tab)
  -> editorActions.addModel(...)
  -> editorActions.setEditor(...)
  -> tabsActions.updateTabs(...)
  -> tabsActions.setSelectedTab(...)
  -> workspaceActions.setSelectedProjectTreeLeaf(...)
```

最终 WorkspaceScreen 因 `editor.type` 变化，渲染对应编辑器。

## 14. 顶部 Tab 切换

Tab 导航文件：

```text
src/renderer/components/_organisms/navigation/index.tsx
src/renderer/components/_molecules/tabs/index.tsx
src/renderer/store/slices/tabs/slice.ts
src/renderer/store/slices/editor/slice.ts
```

调用链：

```text
Navigation
  -> Tabs
  -> Tab.handleClickedTab
  -> sharedWorkspaceActions.openFile(tab)
  -> editorActions.setEditor(...)
  -> tabsActions.setSelectedTab(...)
  -> WorkspaceScreen 按新 editor.type 重渲染
```

关闭 Tab：

```text
Tab.handleDeleteTab
  -> sharedWorkspaceActions.closeFile(tabName)
  -> 如果有未保存改动，openModal('save-changes-file')
  -> 否则 tabsActions.removeTab
  -> editorActions.removeModel
  -> 选择下一个 tab 或进入 available/no tabs 状态
```

## 15. 弹窗渲染管理

Modal slice：

```text
src/renderer/store/slices/modal/slice.ts
```

状态结构：

```ts
modals: {
  'create-project': { open: false, data: null },
  'save-changes-project': { open: false, data: null },
  'runtime-login': { open: false, data: null },
  ...
}
```

打开弹窗：

```text
modalActions.openModal(modal, data)
  -> modals[modal] = { open: true, data }
```

关闭单个弹窗：

```text
modalActions.onOpenChange(modal, false)
  -> modals[modal] = { open: false, data: null }
```

关闭所有弹窗：

```text
modalActions.closeModal()
  -> 遍历 modals，全部 open=false/data=null
```

弹窗被触发的典型位置：

```text
StartScreen
  -> openModal('create-project')

sharedWorkspaceActions.closeProject
  -> openModal('save-changes-project')

sharedWorkspaceActions.closeFile
  -> openModal('save-changes-file')

pouActions.deleteRequest / datatypeActions.deleteRequest
  -> openModal('confirm-delete-element')

Board settings runtime connect
  -> openModal('runtime-login')
  -> openModal('runtime-create-user')
  -> openModal('debugger-message')

useRuntimePolling connection lost
  -> openModal('runtime-connection-lost')

Debugger flow
  -> openModal('debugger-message')
  -> openModal('debugger-ip-input')
```

## 16. 哪些界面是先渲染，哪些界面是触发后渲染

首次启动立即渲染：

```text
AppLayout
StartScreen
Toaster
AcceleratorHandler
TitleBar，取决于 OS
```

首次启动不会渲染：

```text
WorkspaceScreen
Explorer
Navigation
MonacoEditor
GraphicalEditor
DeviceEditor
RuntimeLoginModal
Debugger UI
```

创建或打开项目后渲染：

```text
WorkspaceScreen
WorkspaceActivityBar
Explorer
main tab
Navigation
VariablesEditor
MonacoEditor 或 GraphicalEditor，取决于 main 的语言
Console panel
```

点击项目树节点后渲染：

```text
对应 editor.type 的编辑器
```

点击 New Project 后渲染：

```text
ProjectModal
```

点击 Runtime Connect 后渲染：

```text
RuntimeLoginModal 或 RuntimeCreateUserModal
```

连接丢失后渲染：

```text
RuntimeConnectionLostModal
```

启动 Debugger 后渲染：

```text
Debugger panel tab
VariablesPanel
Debugger chart
```

搜索有结果后渲染：

```text
Search tab
```

PLC logs 打开后渲染：

```text
PlcLogs tab
```

## 17. 一条完整页面切换示例

从首次打开到编辑 main：

```text
main.ts app.whenReady()
  -> createMainWindow()
  -> loadURL(index.html)
  -> preload exposes window.bridge
  -> renderer/index.tsx root.render(<App />)
  -> App reads project.meta.path === ''
  -> AppLayout + StartScreen
  -> User clicks Open
  -> sharedWorkspaceActions.openProject()
  -> MainProcessBridge.handleProjectOpen()
  -> ProjectService.openProject()
  -> readProjectFiles()
  -> sharedWorkspaceActions.handleOpenProjectRequest()
  -> project.meta.path = selected directory
  -> tabs = ['main']
  -> editor = main editor model
  -> App rerenders
  -> AppLayout + WorkspaceScreen
  -> WorkspaceScreen sees tabs.length > 0
  -> Navigation + VariablesEditor + MonacoEditor/GraphicalEditor
```

## 18. 文件职责速查

```text
src/main/main.ts
  Electron 主入口，创建窗口，初始化服务和 IPC。

src/main/utils/resolve-html-path.ts
  根据 dev/prod 解析 renderer HTML URL。

src/main/modules/preload/preload.ts
  把 rendererProcessBridge 暴露成 window.bridge。

src/main/modules/ipc/renderer.ts
  renderer 侧可调用的 IPC API 列表。

src/main/modules/ipc/main.ts
  main 侧 IPC handler 注册和实现。

src/renderer/index.ejs
  HTML 模板，提供 #root。

src/renderer/index.tsx
  React 挂载入口。

src/renderer/App.tsx
  App 级页面选择，StartScreen 或 WorkspaceScreen。

src/renderer/components/_templates/app-layout.tsx
  全局布局、系统配置初始化、全局弹窗挂载。

src/renderer/screens/start-screen.tsx
  启动页。

src/renderer/screens/workspace-screen.tsx
  工作区主界面，编辑器/调试/控制台/日志面板总装配。

src/renderer/store/index.ts
  Zustand root store。

src/renderer/store/slices/modal/slice.ts
  弹窗状态管理。

src/renderer/store/slices/tabs/slice.ts
  Tab 状态管理。

src/renderer/store/slices/editor/slice.ts
  当前编辑器和编辑器模型管理。

src/renderer/store/slices/shared/index.ts
  打开项目、创建项目、打开文件、保存文件等跨 slice 业务动作。
```

# 04. 通信调用链：选择 Runtime v4、连接 Runtime、仿真、上传、调试

本文说明 OpenPLC Editor 中和 Runtime / Simulator / Debugger 相关的通信链路，重点覆盖：

```text
选择连接 Runtime v4
  -> 连接 Runtime
  -> 点击模拟仿真
  -> 上传程序到 Runtime v4
  -> Runtime v4 调试通信
```

## 1. 总览

通信相关能力分为三类：

```text
1. Runtime HTTPS API
   -> 用户检测、登录、创建用户、状态、启动/停止 PLC、日志、上传文件、编译状态、串口列表

2. Debugger 通信
   -> Runtime v4 使用 WebSocket
   -> 普通硬件使用 Modbus TCP/RTU
   -> Simulator 使用 VirtualSerialPort + Modbus RTU client

3. Simulator 通信
   -> renderer 通过 IPC 控制 main 内的 SimulatorModule
   -> main 内部加载 hex 并运行 avr8js 模拟器
```

核心文件：

```text
src/renderer/components/_features/[workspace]/editor/device/configuration/board.tsx
src/renderer/components/_organisms/workspace-activity-bar/default.tsx
src/renderer/hooks/use-runtime-polling.ts
src/renderer/utils/debugger-session.ts
src/main/modules/ipc/renderer.ts
src/main/modules/ipc/main.ts
src/main/modules/compiler/compiler-module.ts
src/main/modules/websocket/websocket-debug-client.ts
src/main/modules/modbus/modbus-client.ts
src/main/modules/modbus/modbus-rtu-client.ts
src/main/modules/simulator/simulator-module.ts
src/main/modules/simulator/virtual-serial-port.ts
```

## 2. 选择 Runtime v4 的入口

设备配置页：

```text
src/renderer/components/_features/[workspace]/editor/device/configuration/board.tsx
```

进入路径：

```text
WorkspaceScreen
  -> Explorer 点击 Device / Configuration
  -> sharedWorkspaceActions.openFile(...)
  -> editor.type = 'plc-device'
  -> WorkspaceScreen 渲染 DeviceEditor
  -> DeviceEditor 渲染 Board Settings
  -> board.tsx
```

选择设备：

```text
Select.onValueChange
  -> handleSetDeviceBoard(board)
```

`handleSetDeviceBoard` 会做几类防护：

```text
1. 如果当前连接 Runtime，切换设备前弹 confirm-device-switch-modal
2. Arduino 目标 + Python FB 时弹 warning
3. 如果项目已有 servers/remoteDevices，而目标不是 Runtime v4 或 Simulator，弹 warning
4. 最终 setDeviceBoard(normalizedBoard)
```

判断 Runtime v4：

```text
isOpenPLCRuntimeV4Target(normalizedBoard)
```

当目标是 Runtime 类型时，UI 显示：

```text
IP Address 输入框
Connect / Disconnect 按钮
连接状态
PLC 状态
timing stats
```

## 3. Runtime v4 连接按钮调用链

入口：

```text
board.tsx
  -> handleConnectToRuntime()
```

调用链：

```text
点击 Connect
  -> if connectionStatus === 'connected'
       -> 断开
       -> setRuntimeJwtToken(null)
       -> setRuntimeConnectionStatus('disconnected')
       -> window.bridge.runtimeClearCredentials()
       -> return
  -> if !runtimeIpAddress return
  -> setRuntimeConnectionStatus('connecting')
  -> window.bridge.runtimeGetUsersInfo(runtimeIpAddress)
```

Renderer bridge：

```text
src/main/modules/ipc/renderer.ts

runtimeGetUsersInfo(ipAddress)
  -> ipcRenderer.invoke('runtime:get-users-info', ipAddress)
```

Main IPC 注册：

```text
src/main/modules/ipc/main.ts

ipcMain.handle('runtime:get-users-info', this.handleRuntimeGetUsersInfo)
```

Main handler：

```text
handleRuntimeGetUsersInfo
  -> GET https://{ip}:8443/api/get-users-info
  -> 读取 header x-openplc-runtime-version
  -> status 404 -> hasUsers: false
  -> status 200 -> hasUsers: true
```

然后 renderer：

```text
validateRuntimeVersion(deviceBoard, result.runtimeVersion)
```

校验结果：

```text
status === 'mismatch'
  -> setRuntimeConnectionStatus('error')
  -> openModal('debugger-message', Runtime Version Mismatch)

status === 'missing'
  -> openModal('debugger-message', Older Runtime Detected)
  -> 用户 Continue Anyway 后继续

status OK
  -> 如果 result.hasUsers
       -> openModal('runtime-login')
     否则
       -> openModal('runtime-create-user')
```

注意：连接按钮本身不直接登录，它先探测 runtime 用户状态和版本，再弹登录或创建用户弹窗。

## 4. Runtime 登录链路

登录弹窗：

```text
src/renderer/components/_organisms/modals/runtime-login-modal.tsx
```

调用链：

```text
RuntimeLoginModal submit
  -> ipAddress = deviceDefinitions.configuration.runtimeIpAddress
  -> window.bridge.runtimeLogin(ipAddress, username, password)
```

bridge：

```text
runtimeLogin(ipAddress, username, password)
  -> ipcRenderer.invoke('runtime:login', ipAddress, username, password)
```

main：

```text
ipcMain.handle('runtime:login', this.handleRuntimeLogin)

handleRuntimeLogin
  -> performAuthentication(ipAddress, username, password)
  -> 如果成功，缓存 runtimeCredentials
```

HTTP：

```text
POST https://{ip}:8443/api/login
body: { username, password }
```

成功响应：

```text
{ access_token: string }
```

renderer 成功后：

```text
deviceActions.setRuntimeJwtToken(accessToken)
deviceActions.setRuntimeConnectionStatus('connected')
modalActions.onOpenChange('runtime-login', false)
```

## 5. Runtime 创建用户链路

创建用户弹窗：

```text
src/renderer/components/_organisms/modals/runtime-create-user-modal.tsx
```

调用链：

```text
RuntimeCreateUserModal submit
  -> window.bridge.runtimeCreateUser(ip, username, password)
  -> 成功后 window.bridge.runtimeLogin(ip, username, password)
  -> 保存 JWT
  -> connectionStatus = connected
```

main HTTP：

```text
POST https://{ip}:8443/api/create-user
body: { username, password, role: 'user' }
```

创建成功后立即登录，避免用户再走一次登录流程。

## 6. Runtime 连接状态和日志轮询

Hook：

```text
src/renderer/hooks/use-runtime-polling.ts
```

挂载位置：

```text
src/renderer/screens/workspace-screen.tsx

useRuntimePolling()
```

触发条件：

```text
connectionStatus === 'connected'
jwtToken 存在
runtimeIpAddress 存在
```

轮询内容：

```text
window.bridge.runtimeGetStatus(currentIpAddress, currentJwtToken, includeTimingStatsInPolling)
window.bridge.runtimeGetLogs(currentIpAddress, currentJwtToken, minId)
```

Main API：

```text
runtime:get-status
  -> GET /api/status 或 /api/status?include_stats=true

runtime:get-logs
  -> GET /api/runtime-logs
  -> v4 支持 id 增量: /api/runtime-logs?id={minId}
```

轮询结果：

```text
status
  -> setPlcRuntimeStatus(...)

timingStats
  -> setTimingStats(...)

logs
  -> v4 structured logs: RuntimeLogEntry[]
  -> v3 plain string logs
  -> appendPlcLogs / setPlcLogs
```

连接丢失：

```text
handleConnectionLost
  -> setRuntimeJwtToken(null)
  -> setRuntimeConnectionStatus('disconnected')
  -> setPlcRuntimeStatus(null)
  -> openModal('runtime-connection-lost', { ipAddress })
```

弹窗：

```text
src/renderer/components/_organisms/modals/runtime-connection-lost-modal.tsx
```

## 7. Token 自动刷新

MainProcessBridge 缓存：

```text
runtimeCredentials: { ipAddress, username, password } | null
tokenRefreshInFlight
```

所有 Runtime API 通用请求入口：

```text
makeRuntimeApiRequest(ipAddress, jwtToken, endpoint, responseParser)
```

如果响应是 token 过期：

```text
isTokenExpiredError(statusCode, data)
  -> attemptTokenRefresh()
  -> performAuthentication(...)
  -> mainWindow.webContents.send('runtime:token-refreshed', newToken)
  -> 用新 token 重试原请求
```

renderer 监听：

```text
WorkspaceScreen useEffect
  -> window.bridge.onRuntimeTokenRefreshed(...)
  -> deviceActions.setRuntimeJwtToken(newToken)
```

所以 Runtime API 的 token 刷新是在 main 侧透明处理，renderer 只接收新 token 更新状态。

## 8. Runtime Start / Stop PLC 链路

入口：

```text
src/renderer/components/_organisms/workspace-activity-bar/default.tsx
```

非 simulator 目标时，PlayButton 表示 Runtime PLC start/stop：

```text
PlayButton.onClick
  -> handlePlcControl()
```

调用链：

```text
handlePlcControl
  -> if !runtimeIpAddress || !jwtToken || connectionStatus !== 'connected' return
  -> if plcStatus === 'RUNNING'
       -> window.bridge.runtimeStopPlc(runtimeIpAddress, jwtToken)
     else
       -> window.bridge.runtimeStartPlc(runtimeIpAddress, jwtToken)
  -> window.bridge.runtimeGetStatus(...)
  -> setPlcRuntimeStatus(parsePlcStatus(status))
```

Main API：

```text
runtime:start-plc
  -> GET /api/start-plc

runtime:stop-plc
  -> GET /api/stop-plc

runtime:get-status
  -> GET /api/status
```

## 9. Simulator 选择和点击模拟仿真链路

如果当前 board 是 simulator：

```text
isCurrentBoardSimulator = isSimulatorTarget(currentBoardInfo)
```

ActivityBar 行为变化：

```text
DownloadButton
  -> disabled
  -> tooltip: Use Start to build and run

PlayButton
  -> Start Simulator / Stop Simulator

DebuggerButton
  -> disabled
  -> tooltip: Use Start to debug
```

点击 PlayButton：

```text
PlayButton.onClick
  -> handleSimulatorControl()
```

启动 simulator：

```text
handleSimulatorControl
  -> if simulatorRunning
       -> disconnectDebugger
       -> window.bridge.simulatorStop()
       -> setSimulatorRunning(false)
     else
       -> pendingSimulatorDebugRef.current = true
       -> verifyAndCompile()
```

`verifyAndCompile`：

```text
如果 unsaved
  -> saveProject
然后 handleRequest
```

`handleRequest`：

```text
preprocessPous(projectData, isCurrentBoardSimulator, addLog)
window.bridge.runCompileProgram([...])
```

编译 main 侧：

```text
MainProcessBridge.handleRunCompileProgram
  -> CompilerModule.compileProgram
```

当 `boardRuntime === 'simulator'`：

```text
CompilerModule.compileProgram
  -> 编译 Arduino firmware
  -> hexPath = build/.../Baremetal.ino.hex
  -> MessagePort postMessage({ simulatorFirmwarePath: hexPath, closePort: true })
```

renderer 收到：

```text
if data.simulatorFirmwarePath
  -> window.bridge.simulatorLoadFirmware(data.simulatorFirmwarePath)
  -> 成功 setSimulatorRunning(true)
  -> 如果 pendingSimulatorDebugRef.current
       -> connectDebuggerAfterBuild()
```

main handler：

```text
simulator:load-firmware
  -> MainProcessBridge.handleSimulatorLoadFirmware
  -> simulatorModule.loadAndRun(hexPath)
```

相关文件：

```text
src/main/modules/simulator/simulator-module.ts
src/main/modules/simulator/virtual-serial-port.ts
```

## 10. Simulator Debugger 自动连接

Simulator 编译加载成功后：

```text
connectDebuggerAfterBuild()
```

调用链：

```text
readDebugFile(projectPath, boardTarget)
  -> main 读取 build/{boardTarget}/src/debug.c

parseDebugFile(debug.c)
  -> 提取变量索引等调试信息

buildVariableIndexMap(project.data.pous, instances, parsed)
buildDebugVariableTreeMap(project.data.pous, instances, parsed.variables, project)
buildFbInstanceMap(project.data.pous, instances)

connectAndActivateDebugger({
  connectionType: 'simulator',
  connectionParams: {},
  indexMap,
  treeMap,
  fbDebugInstancesMap
})
```

`connectAndActivateDebugger`：

```text
window.bridge.debuggerConnect('simulator', {})
  -> ipcRenderer.invoke('debugger:connect', 'simulator', {})
  -> MainProcessBridge.handleDebuggerConnect
  -> new VirtualSerialPort(simulatorModule)
  -> new ModbusRtuClient({ serialPort: virtualPort })
  -> connect()
  -> getMd5Hash() 触发 endianness detection
```

激活后：

```text
workspaceActions.setDebuggerVisible(true)
workspaceActions.setDebugVariableIndexes(indexMap)
workspaceActions.setDebugVariableTree(treeMap)
workspaceActions.setFbDebugInstances(fbDebugInstancesMap)
```

WorkspaceScreen 看到 `isDebuggerVisible` 后开始变量轮询。

## 11. Runtime v4 上传程序入口

Runtime v4 上传不是独立按钮，而是 Compile/Download 按钮在 Runtime v4 目标且非 compileOnly 时触发。

入口：

```text
src/renderer/components/_organisms/workspace-activity-bar/default.tsx

DownloadButton.onClick
  -> verifyAndCompile()
```

前置条件：

```text
deviceBoard = OpenPLC Runtime v4
runtimeIpAddress 已配置
runtimeJwtToken 已存在
compileOnly = false
```

如果没有 runtimeIpAddress 或 runtimeJwtToken：

```text
CompilerModule.compileProgram
  -> Runtime not configured or not logged in. Skipping upload to runtime.
```

## 12. Runtime v4 上传程序完整调用链

renderer：

```text
verifyAndCompile
  -> saveProject if unsaved
  -> handleRequest
  -> preprocessPous
  -> window.bridge.runCompileProgram([
       projectPath,
       boardTarget,
       boardCore,
       compileOnly,
       processedProjectData,
       runtimeIpAddress,
       runtimeJwtToken
     ])
```

IPC：

```text
runCompileProgram
  -> MessageChannel
  -> ipcRenderer.postMessage('compiler:run-compile-program', args, [mainProcessPort])
```

main：

```text
MainProcessBridge.handleRunCompileProgram
  -> compilerModule.compileProgram(args, port, this)
```

compiler：

```text
CompilerModule.compileProgram
  -> JSON -> XML
  -> XML -> ST
  -> ST -> C
  -> debug/glue/C blocks
  -> boardRuntime === 'openplc-compiler'
  -> boardTarget !== 'OpenPLC Runtime v3'
  -> Runtime v4 branch
```

Runtime v4 branch：

```text
cleanConfFolder
handleGenerateModbusSlaveConfig
handleGenerateModbusMasterConfig
handleGenerateS7CommConfig
handleGenerateOpcUaConfig
compressSourceFolder(sourceTargetFolderPath)
filename = program.zip
POST /api/upload-file
poll /api/compilation-status
GET /api/status
```

## 13. Runtime v4 上传前生成的配置文件

Runtime v4 支持项目中的 servers 和 remote devices，所以上传前会生成 `conf` 目录。

Modbus Server：

```text
handleGenerateModbusSlaveConfig
  -> generateModbusSlaveConfig(projectData.servers)
  -> conf/modbus_slave.json
```

Remote IO / Modbus Master：

```text
handleGenerateModbusMasterConfig
  -> generateModbusMasterConfig(projectData.remoteDevices)
  -> conf/modbus_master.json
```

S7Comm：

```text
handleGenerateS7CommConfig
  -> generateS7CommConfig(projectData.servers)
  -> conf/s7comm.json
```

OPC-UA：

```text
handleGenerateOpcUaConfig
  -> 读取 debug.c
  -> instances = projectData.configuration.resource.instances
  -> generateOpcUaConfig(projectData.servers, debugContent, instances)
  -> conf/opcua.json
```

这些文件最终都会被压进 `program.zip`。

## 14. Runtime v4 上传 HTTP 请求

main 侧使用 Node `https.request`。

请求：

```text
POST https://{runtimeIpAddress}:8443/api/upload-file
Authorization: Bearer {runtimeJwtToken}
Content-Type: multipart/form-data; boundary=...
Content-Length: ...
```

表单字段：

```text
name="file"
filename="program.zip"
Content-Type: application/zip
```

成功：

```text
HTTP 200
  -> Program uploaded successfully to runtime.
  -> Runtime compilation started: COMPILING
```

随后轮询：

```text
GET /api/compilation-status
  -> status === SUCCESS
       -> Compilation completed successfully
  -> status === FAILED
       -> Compilation failed
  -> logs 有新增
       -> parseLogLevel(log)
       -> 通过 MessagePort 发给 renderer console
```

## 15. Runtime v4 Debugger 入口

非 simulator 下，DebuggerButton 可点击。

入口：

```text
DefaultWorkspaceActivityBar
  -> DebuggerButton.onClick
  -> handleDebuggerClick()
```

如果当前已经在调试：

```text
workspace.isDebuggerVisible
  -> disconnectDebugger(workspaceActions)
```

如果未在调试：

```text
1. 如果 unsaved，先 saveProject
2. 判断 boardTarget/currentBoardInfo
3. isRuntimeTarget = isOpenPLCRuntimeTarget(currentBoardInfo)
4. isRuntimeV4 = boardTarget === 'OpenPLC Runtime v4'
5. Runtime v4:
   connectionType = 'websocket'
   jwtToken = runtimeConnection.jwtToken
```

连接前检查：

```text
connectionStatus !== 'connected' || !runtimeIpAddress
  -> openModal('debugger-message', Connection Required)

Runtime v4 jwtToken 缺失
  -> openModal('debugger-message', Authentication Required)
```

## 16. Runtime v4 Debugger 编译和 MD5 校验

Debugger 启动前会做 debug compilation：

```text
window.bridge.runDebugCompilation(
  [projectPath, boardTarget, processedProjectData],
  callback
)
```

IPC：

```text
ipcRenderer.postMessage('compiler:run-debug-compilation', args, [port])
ipcMain.on('compiler:run-debug-compilation', this.handleRunDebugCompilation)
compilerModule.compileForDebugger(args, port)
```

`compileForDebugger` 生成：

```text
plc.xml
program.st
C files
debug.c
LOCATED_VARIABLES.h
C/C++ blocks
```

完成后：

```text
handleMd5Verification(...)
```

MD5 校验步骤：

```text
1. 如果 Runtime PLC STOPPED，询问是否 start PLC
2. window.bridge.debuggerReadProgramStMd5(projectPath, boardTarget)
   -> main 读取 build/{boardTarget}/src/program.st
   -> 提取 DBG md5
3. window.bridge.debuggerVerifyMd5(connectionType='websocket', connectionParams, expectedMd5)
   -> main WebSocketDebugClient 连接 Runtime v4 debugger
   -> 获取 targetMd5
4. match
   -> 读取 debug.c，启动 debugger
5. mismatch
   -> 弹 Program Mismatch
   -> 用户 Yes 后 runCompileProgram 上传当前程序
   -> 上传完成后重新 handleMd5Verification
```

这解释了“调试时为什么可能提示上传程序”：因为编辑器当前编译出的 MD5 和 Runtime 正在运行的程序 MD5 不一致。

## 17. Runtime v4 Debugger WebSocket 连接

main handler：

```text
MainProcessBridge.handleDebuggerConnect
```

Runtime v4 分支：

```text
connectionType === 'websocket'
  -> require ipAddress + jwtToken
  -> new WebSocketDebugClient({
       host: ipAddress,
       port: 8443,
       token: jwtToken,
       rejectUnauthorized: false
     })
  -> connect()
  -> debuggerTargetIp = ipAddress
  -> debuggerJwtToken = jwtToken
  -> debuggerConnectionType = 'websocket'
```

相关文件：

```text
src/main/modules/websocket/websocket-debug-client.ts
```

连接成功后 renderer 侧激活：

```text
connectAndActivateDebugger(...)
  -> workspaceActions.setDebuggerVisible(true)
  -> setDebugVariableIndexes(indexMap)
  -> setDebugVariableTree(treeMap)
  -> setFbDebugInstances(fbDebugInstancesMap)
```

## 18. Runtime v4 Debugger 变量轮询

WorkspaceScreen 中有一个 effect 监听 `isDebuggerVisible`。

文件：

```text
src/renderer/screens/workspace-screen.tsx
```

触发：

```text
if isDebuggerVisible
  -> 构建 variableInfoMap
  -> pollVariables()
  -> setInterval(..., 50ms)
```

每次轮询：

```text
window.bridge.debuggerGetVariablesList(batch)
```

main：

```text
ipcMain.handle('debugger:get-variables-list', this.handleDebuggerGetVariablesList)
```

Runtime v4 WebSocket 分支：

```text
if debuggerConnectionType === 'websocket'
  -> debuggerWebSocketClient.getVariablesList(variableIndexes)
  -> 返回 tick/lastIndex/data
```

renderer 解析：

```text
parseVariableValue(...)
setDebugVariableValues(newValues)
```

如果 WebSocket 断了：

```text
debuggerWebSocketClient.disconnect()
debuggerWebSocketClient = null
下一次 getVariablesList 尝试用 debuggerTargetIp + debuggerJwtToken 重连
```

## 19. Runtime v4 Debugger 强制变量

变量强制入口包括：

```text
VariablesPanel
Ladder contact/coil debug controls
FBD variable debug controls
```

最终调用：

```text
window.bridge.debuggerSetVariable(variableIndex, force, valueBuffer)
```

main：

```text
handleDebuggerSetVariable
  -> if debuggerConnectionType === 'websocket'
       -> debuggerWebSocketClient.setVariable(variableIndex, force, buffer)
     else
       -> debuggerModbusClient.setVariable(...)
```

所以 Runtime v4 强制变量走 WebSocket，非 v4 硬件和 simulator 走 Modbus client。

## 20. 通信协议分支总结

### 20.1 Runtime v4

```text
连接/状态/日志/上传/启动停止
  -> HTTPS 8443

调试变量
  -> WebSocketDebugClient，端口 8443，JWT 鉴权
```

### 20.2 Runtime v3

```text
上传
  -> HTTPS /api/upload-file
  -> 文件是 program.st

调试
  -> 通常不是 websocket，按 Modbus TCP/RTU 分支
```

### 20.3 普通硬件

```text
编译
  -> Arduino CLI

上传
  -> handleUploadProgram，通常走 arduino-cli upload

调试
  -> Modbus TCP 或 Modbus RTU
```

### 20.4 Simulator

```text
编译
  -> Arduino firmware hex

运行
  -> simulatorLoadFirmware(hexPath)
  -> SimulatorModule.loadAndRun

调试
  -> VirtualSerialPort + ModbusRtuClient
```

## 21. 从 Runtime v4 选择到上传的一条完整链

```text
Explorer 点击 Device Configuration
  -> openFile Configuration
  -> WorkspaceScreen 渲染 DeviceEditor
  -> board.tsx

用户选择 OpenPLC Runtime v4
  -> handleSetDeviceBoard
  -> setDeviceBoard('OpenPLC Runtime v4')
  -> UI 显示 IP Address 和 Connect

用户输入 IP 并点击 Connect
  -> handleConnectToRuntime
  -> runtimeGetUsersInfo
  -> GET /api/get-users-info
  -> validateRuntimeVersion
  -> open runtime-login 或 runtime-create-user

用户登录
  -> runtimeLogin
  -> POST /api/login
  -> access_token
  -> runtimeConnection.jwtToken = token
  -> runtimeConnection.connectionStatus = connected

WorkspaceScreen
  -> useRuntimePolling
  -> GET /api/status
  -> GET /api/runtime-logs

用户点击 Compile/Download
  -> verifyAndCompile
  -> saveProject if unsaved
  -> preprocessPous
  -> runCompileProgram
  -> CompilerModule.compileProgram
  -> JSON -> XML -> ST -> C
  -> debug/glue/C blocks
  -> generate conf/*.json
  -> compressSourceFolder(src) -> program.zip
  -> POST /api/upload-file
  -> poll /api/compilation-status
  -> GET /api/status
  -> 更新 UI 中 PLC 状态
```

## 22. 从点击模拟仿真到调试的一条完整链

```text
用户选择 Simulator target
  -> ActivityBar Download disabled
  -> PlayButton 变成 Start Simulator

点击 Start Simulator
  -> handleSimulatorControl
  -> pendingSimulatorDebugRef = true
  -> verifyAndCompile
  -> runCompileProgram
  -> CompilerModule.compileProgram
  -> Arduino/simulator 编译路径
  -> 返回 simulatorFirmwarePath

renderer 收到 simulatorFirmwarePath
  -> simulatorLoadFirmware(hexPath)
  -> MainProcessBridge.handleSimulatorLoadFirmware
  -> SimulatorModule.loadAndRun(hexPath)
  -> setSimulatorRunning(true)

pendingSimulatorDebugRef 为 true
  -> connectDebuggerAfterBuild
  -> readDebugFile(debug.c)
  -> parseDebugFile
  -> buildVariableIndexMap/tree/fbInstanceMap
  -> debuggerConnect('simulator')
  -> VirtualSerialPort + ModbusRtuClient
  -> workspace.isDebuggerVisible = true

WorkspaceScreen
  -> 50ms 轮询 debuggerGetVariablesList
  -> 更新 VariablesPanel 和图形节点 debug badge
```

## 23. 文件职责速查

```text
src/renderer/components/_features/[workspace]/editor/device/configuration/board.tsx
  选择设备、Runtime IP、Connect/Disconnect、Runtime 版本校验入口。

src/renderer/components/_organisms/modals/runtime-login-modal.tsx
  Runtime 登录弹窗。

src/renderer/components/_organisms/modals/runtime-create-user-modal.tsx
  Runtime 创建用户并登录。

src/renderer/hooks/use-runtime-polling.ts
  Runtime status/logs/timing stats 轮询和连接丢失处理。

src/renderer/components/_organisms/workspace-activity-bar/default.tsx
  Compile/Upload、Start/Stop PLC、Start/Stop Simulator、Debugger 主入口。

src/renderer/utils/debugger-session.ts
  Debugger 激活/断开、变量索引和树状态提交的公共逻辑。

src/main/modules/ipc/renderer.ts
  renderer bridge，定义 runtime/debugger/simulator/compiler IPC API。

src/main/modules/ipc/main.ts
  Runtime HTTPS API handler、Debugger handler、Simulator handler。

src/main/modules/compiler/compiler-module.ts
  Runtime v4 program.zip 生成、上传、编译状态轮询。

src/main/modules/websocket/websocket-debug-client.ts
  Runtime v4 debugger WebSocket 客户端。

src/main/modules/modbus/modbus-client.ts
  Modbus TCP 调试客户端。

src/main/modules/modbus/modbus-rtu-client.ts
  Modbus RTU 调试客户端。

src/main/modules/simulator/simulator-module.ts
  Simulator 固件加载和运行。

src/main/modules/simulator/virtual-serial-port.ts
  Simulator 调试时给 ModbusRtuClient 使用的虚拟串口。

src/utils/runtime-https-config.ts
  Runtime HTTPS 请求配置，例如证书校验相关选项。
```

# 03. 核心业务调用链：创建、编辑、保存、编译、生成压缩包

本文说明 OpenPLC Editor 作为 PLC 程序编辑器，从创建项目、编辑 POU、保存文件，到最终编译并在 Runtime v4 场景下生成压缩包上传的核心业务链路。

## 1. 总览

完整主链路：

```text
创建项目
  -> 创建项目目录和默认文件
  -> 写入 project.json / devices / main POU
  -> renderer store 初始化 project/pous/files/tabs/editor
  -> WorkspaceScreen 渲染 main 编辑器

编辑项目
  -> Explorer 打开文件
  -> 根据 editor.type 渲染 Monaco/Graphical/DataType/Device/Server/Resource
  -> 修改 Zustand project/editor/flow 状态
  -> 标记 file/workspace unsaved

保存项目
  -> validate project/device/pinMapping
  -> POU sanitize
  -> project.json 去掉 pous，只保留项目级数据
  -> POU 序列化成文本文件
  -> devices/server/remote 写到对应目录

编译
  -> preprocessPous
  -> runCompileProgram IPC
  -> CompilerModule.compileProgram
  -> JSON -> XML -> ST -> C -> debug/glue/config
  -> Runtime v4: src 文件夹压缩为 program.zip
  -> 上传到 Runtime v4 /api/upload-file
```

## 2. 项目文件模型

创建项目后，文件结构大致是：

```text
project-root/
  project.json
  devices/
    configuration.json
    pin-mapping.json
    servers/
      *.json
    remote/
      *.json
  pous/
    programs/
      main.st / main.il / main.ld / main.fbd ...
    functions/
      *.st / *.il ...
    function-blocks/
      *.st / *.ld / *.fbd / *.py / *.cpp ...
  build/
    {boardTarget}/
      src/
        plc.xml
        program.st
        debug.c
        LOCATED_VARIABLES.h
        conf/
          modbus_slave.json
          modbus_master.json
          s7comm.json
          opcua.json
```

项目状态主要存在 renderer store：

```text
project.meta
  -> name/type/path

project.data
  -> pous
  -> dataTypes
  -> configuration.resource.tasks
  -> configuration.resource.instances
  -> configuration.resource.globalVariables
  -> servers
  -> remoteDevices
  -> deletedPous / deletedServers / deletedRemoteDevices
```

相关文件：

```text
src/renderer/store/slices/project/slice.ts
src/types/PLC/open-plc.ts
src/types/PLC/project/*
```

## 3. 创建项目入口

启动页入口：

```text
src/renderer/screens/start-screen.tsx
```

点击 New Project：

```text
handleCreateProject
  -> modalActions.openModal('create-project', null)
```

弹窗挂载：

```text
src/renderer/components/_templates/app-layout.tsx

modals['create-project'].open === true
  -> <ProjectModal isOpen={...} />
```

项目创建弹窗：

```text
src/renderer/components/_features/[start]/new-project/project-modal.tsx
src/renderer/components/_features/[start]/new-project/steps/first-step.tsx
src/renderer/components/_features/[start]/new-project/steps/second-step.tsx
src/renderer/components/_features/[start]/new-project/steps/third-step.tsx
src/renderer/components/_features/[start]/new-project/store/index.ts
```

`ProjectModal` 管理三步流程：

```text
Step1
  -> 项目名称等基础信息

Step2
  -> 路径/语言等信息

Step3
  -> 确认创建
```

最终会调用：

```text
sharedWorkspaceActions.createProject(dataToCreateProjectFile)
```

## 4. 创建项目 renderer 到 main 调用链

renderer 动作定义：

```text
src/renderer/store/slices/shared/index.ts
```

调用链：

```text
sharedWorkspaceActions.createProject(data)
  -> window.bridge.createProject(data)
  -> ipcRenderer.invoke('project:create', data)
```

bridge 文件：

```text
src/main/modules/ipc/renderer.ts
```

```ts
createProject: (data) => ipcRenderer.invoke('project:create', data)
```

main 侧注册：

```text
src/main/modules/ipc/main.ts
```

```text
setupMainIpcListener()
  -> ipcMain.handle('project:create', this.handleProjectCreate)
```

handler：

```text
handleProjectCreate
  -> stopSimulatorAndNotify()
  -> projectService.createProject(data)
```

服务：

```text
src/main/services/project-service/index.ts
```

```text
ProjectService.createProject(data)
  -> createProjectDefaultStructure(data.path, data)
  -> updateProjectHistory(data.path)
  -> 返回 meta.path + content
```

实际创建文件：

```text
src/main/services/project-service/utils/create-project.ts
```

## 5. createProjectDefaultStructure 做了什么

核心函数：

```text
createProjectDefaultStructure(basePath, dataToCreateProjectFile)
```

步骤：

```text
1. 根据 projectDefaultDirectories 创建目录
2. 创建 project.json
3. 创建 devices/configuration.json
4. 创建 devices/pin-mapping.json
5. 根据用户选择语言创建默认 main POU
6. 把 main POU 序列化成文本文件写入 pous/programs
7. 返回 project、pous、deviceConfiguration、devicePinMapping
```

默认 project.json 由 `createProjectFile` 创建：

```text
meta.name
meta.type
data.pous = []
data.dataTypes = []
data.configuration.resource.tasks = [task0]
data.configuration.resource.instances = [instance0 -> main/task0]
data.configuration.resource.globalVariables = []
```

默认 POU 由 `definePou(language)` 创建：

```text
type: 'program'
data.name: 'main'
data.language: 用户选择语言
data.variables: []
data.body:
  ld  -> { language: 'ld', value: { name: 'main', rungs: [] } }
  fbd -> { language: 'fbd', value: { name: 'main', rung: { nodes, edges, comment } } }
  其他 -> { language, value: '' }
```

POU 写文件时：

```text
getExtensionFromLanguage(language)
serializePouToText(pou)
writeFileSync(`${pouPath}/${pou.data.name}${extension}`, textContent)
```

所以新项目的 POU 文件已经不是老的 JSON 文件，而是按语言扩展名保存的文本格式。

## 6. 创建项目成功后 renderer 状态初始化

回到：

```text
src/renderer/store/slices/shared/index.ts
```

`createProject` 成功后：

```text
window.bridge.rebuildMenu()
clearStatesOnCloseProject()
projectActions.setProject(...)
projectActions.setPous(pous)
如果 POU 是 fbd -> fbdFlowActions.addFBDFlow(...)
如果 POU 是 ld  -> ladderFlowActions.addLadderFlow(...)
workspaceActions.setEditingState('unsaved')
创建 files map
创建 main tab
创建 main editor model
设置 selectedTab = main
设置 selectedProjectTreeLeaf = main
toast success
```

关键效果：

```text
project.meta.path 被设置
  -> App.tsx 从 StartScreen 切到 WorkspaceScreen

tabs 有 main
  -> WorkspaceScreen 渲染 Navigation

editor 是 main model
  -> WorkspaceScreen 根据 main 的语言渲染 MonacoEditor 或 GraphicalEditor
```

## 7. 打开项目和加载编辑状态

打开已有项目入口：

```text
StartScreen Open
  -> sharedWorkspaceActions.openProject()
```

调用链：

```text
openProject
  -> clearStatesOnCloseProject()
  -> window.bridge.openProject()
  -> ipcRenderer.invoke('project:open')
  -> MainProcessBridge.handleProjectOpen()
  -> ProjectService.openProject()
  -> dialog.showOpenDialog(openDirectory)
  -> readProjectFiles(directoryPath)
  -> updateProjectHistory(directoryPath)
  -> 返回项目内容
  -> handleOpenProjectRequest(data)
```

`handleOpenProjectRequest` 做的事很多，是打开项目后的核心装载器：

```text
1. workspace.editingState = saved
2. 拆出 project / pous / deviceConfiguration / devicePinMapping
3. projectActions.setProject(...)
4. projectActions.setPous(pous)
5. LD POU -> ladderFlowActions.addLadderFlow
6. FBD POU -> fbdFlowActions.addFBDFlow
7. 非 program POU 加入 user library
8. 重新解析变量类型，修正 FB/struct 等分类
9. 同步图形节点变量引用
10. 默认打开 main program
11. 设置 deviceDefinitions
12. 恢复 debugVariables 标记
13. 构造 file slice
14. toast Project opened
```

重新解析变量的原因：

```text
POU 文本解析阶段没有完整项目上下文，无法准确判断一个名字是 function block、struct 还是普通 user-data-type。
打开项目后拥有 pous/dataTypes/libraries，重新 parseIecStringToVariables 修正类型定义。
```

## 8. 打开文件到编辑器渲染

Explorer 项目树：

```text
src/renderer/components/_organisms/explorer/project.tsx
```

点击 POU：

```text
ProjectTreeLeaf.onClick
  -> sharedWorkspaceActions.openFile({
       name,
       path,
       elementType
     })
```

点击 Resource：

```text
openFile({
  name: 'Resource',
  path: '/project.json',
  elementType: { type: 'resource' }
})
```

点击 Device Configuration：

```text
openFile({
  name: 'Configuration',
  path: '/device',
  elementType: { type: 'device', derivation: 'configuration' }
})
```

点击 Server：

```text
openFile({
  name: server.name,
  path: `/devices/servers/${server.name}.json`,
  elementType: { type: 'server', protocol: server.protocol }
})
```

点击 Remote Device：

```text
openFile({
  name: device.name,
  path: `/devices/remote/${device.name}.json`,
  elementType: { type: 'remote-device', protocol: device.protocol }
})
```

`openFile` 会：

```text
1. 根据 tab 创建 editor model
2. editorActions.addModel
3. editorActions.setEditor
4. tabsActions.updateTabs
5. tabsActions.setSelectedTab
6. workspaceActions.setSelectedProjectTreeLeaf
```

然后：

```text
WorkspaceScreen
  -> editor.type 条件渲染对应编辑器
```

## 9. 创建 POU / DataType / Server / RemoteDevice

入口：

```text
src/renderer/components/_features/[workspace]/create-element/index.tsx
src/renderer/components/_features/[workspace]/create-element/element-card/index.tsx
```

Explorer 顶部 `+`：

```text
CreatePLCElement
  -> Popover
  -> ElementCard(function/function-block/program/data-type/server/remote-device)
```

### 9.1 创建 POU

调用链：

```text
ElementCard form submit
  -> handleCreatePou
  -> pouActions.create(data)
```

`pouActions.create` 在：

```text
src/renderer/store/slices/shared/index.ts
```

步骤：

```text
1. CreatePouObject(props)
2. projectActions.createPou(newPouData)
3. window.bridge.createPouFile({ path, pou })
4. 根据语言创建 editorData
   textual: il/st/python/cpp -> plc-textual
   graphical: ld/fbd/sfc -> plc-graphical
5. fbd -> fbdFlowActions.addFBDFlow
6. ld -> ladderFlowActions.addLadderFlow
7. 非 program -> libraryActions.addLibrary
8. fileActions.addFile
9. editorActions.addModel + setEditor
10. tabsActions.updateTabs + setSelectedTab
11. workspaceActions.setSelectedProjectTreeLeaf
```

文件创建 IPC：

```text
window.bridge.createPouFile
  -> ipcRenderer.invoke('pou:create')
  -> MainProcessBridge.handleCreatePouFile
  -> PouService.createPouFile
```

### 9.2 创建 DataType

调用链：

```text
ElementCard handleCreateDatatype
  -> datatypeActions.create(draft)
  -> projectActions.createDatatype(...)
  -> 写入 project.data.dataTypes
  -> 需要保存项目时才落到 project.json
```

DataType 不像 POU 那样单独创建文本文件，而是项目级数据，保存时写入 `project.json`。

### 9.3 创建 Server

调用链：

```text
ElementCard handleCreateServer
  -> projectActions.createServer({ data })
  -> fileActions.addFile({ type: 'server', filePath: '/project.json', isNew: true })
  -> openFile({ elementType: { type: 'server', protocol } })
```

Server 当前只允许 Runtime v4 或 Simulator 目标下创建：

```text
allowServersAndRemoteDevices = isRuntimeV4 || isSimulator
```

保存项目时，server 会写到：

```text
devices/servers/{server.name}.json
```

### 9.4 创建 RemoteDevice

调用链：

```text
ElementCard handleCreateRemoteDevice
  -> projectActions.createRemoteDevice({ data })
  -> fileActions.addFile({ type: 'remote-device', filePath: '/project.json', isNew: true })
  -> openFile({ elementType: { type: 'remote-device', protocol } })
```

保存项目时，remote device 会写到：

```text
devices/remote/{device.name}.json
```

## 10. 文本编辑器和图形编辑器如何更新业务状态

WorkspaceScreen 判断：

```text
editor.type === 'plc-textual'
  -> VariablesEditor
  -> MonacoEditor

editor.type === 'plc-graphical'
  -> VariablesEditor
  -> GraphicalEditor
```

文本编辑器：

```text
src/renderer/components/_features/[workspace]/editor/monaco/index.tsx
```

它负责 Monaco 代码显示、语言配置、补全、变量代码模式等。

图形编辑器：

```text
src/renderer/components/_features/[workspace]/editor/graphical/index.tsx
src/renderer/components/_features/[workspace]/editor/graphical/ladder/index.tsx
src/renderer/components/_features/[workspace]/editor/graphical/FBD/index.tsx
src/renderer/components/_molecules/graphical-editor/ladder/*
src/renderer/components/_molecules/graphical-editor/fbd/*
```

LD/FBD 图形状态分别存储在：

```text
src/renderer/store/slices/ladder/slice.ts
src/renderer/store/slices/fbd/slice.ts
```

项目数据最终仍在：

```text
project.data.pous[].data.body
project.data.pous[].data.variables
```

保存前会把 editor/flow/project 状态整理成可序列化的项目内容。

## 11. 标记未保存状态

跨文件保存状态主要在：

```text
src/renderer/store/slices/files/*
src/renderer/store/slices/workspace/*
src/renderer/store/slices/shared/index.ts
```

关键动作：

```text
sharedWorkspaceActions.handleFileAndWorkspaceSavedState(name)
  -> 如果 file.saved === true，改成 false
  -> 如果 workspace.editingState 不是 unsaved，改成 unsaved
```

关闭项目或关闭文件时会检查：

```text
closeProject
  -> fileActions.checkIfAllFilesAreSaved()
  -> workspace.editingState
  -> 有未保存则 openModal('save-changes-project')

closeFile
  -> 单文件未保存则 openModal('save-changes-file')
```

## 12. 保存项目调用链

入口可能来自：

```text
Menu
快捷键
关闭项目前保存
Compile 前自动保存
用户显式保存
```

Renderer 调用：

```text
sharedWorkspaceActions.saveProject(project, deviceDefinitions)
```

文件：

```text
src/renderer/store/slices/shared/index.ts
```

步骤：

```text
1. workspace.editingState = save-request
2. PLCProjectSchema.safeParse(project)
3. deviceConfigurationSchema.safeParse(...)
4. devicePinSchema.array().safeParse(...)
5. 收集当前 editors，准备 sanitize POU
6. sanitizedPous = project.data.pous.map(sanitizePou)
7. projectData.data.pous = []
8. 收集 debugVariables
9. window.bridge.saveProject(...)
10. 成功后 workspace.editingState = saved
11. fileActions.setAllToSaved()
12. 清理 deletedPous/deletedServers/deletedRemoteDevices
```

为什么 `projectData.data.pous = []`：

```text
POU 不直接存 project.json。
project.json 只存项目结构、资源、类型、debugVariables 等项目级信息。
POU 单独写到 pous/programs、pous/functions、pous/function-blocks 下。
```

## 13. 保存项目 main 侧链路

renderer bridge：

```text
window.bridge.saveProject(data)
  -> ipcRenderer.invoke('project:save', data)
```

main：

```text
MainProcessBridge.setupMainIpcListener
  -> ipcMain.handle('project:save', this.handleProjectSave)

handleProjectSave
  -> projectService.saveProject({ projectPath, content })
```

ProjectService：

```text
src/main/services/project-service/index.ts
```

`saveProject` 写入：

```text
Promise.all([
  project.json,
  devices/configuration.json,
  devices/pin-mapping.json
])
```

然后写 POU：

```text
savedPous = {
  programs,
  functions,
  function-blocks
}

for each pou:
  language = pou.data.body.language
  extension = getExtensionFromLanguage(language)
  textContent = serializePouToText(pou)
  writeFile(`${dir}/${pou.data.name}${extension}`, textContent)
```

然后处理删除：

```text
projectData.data.deletedPous
  -> 删除对应语言文件
  -> 删除旧版 .json POU 文件
```

然后写 server：

```text
devices/servers/{server.name}.json
```

然后写 remote device：

```text
devices/remote/{remoteDevice.name}.json
```

## 14. 单文件保存

入口：

```text
sharedWorkspaceActions.saveFile(name)
```

逻辑：

```text
根据 file.type 决定 saveContent 和 filePath

program/function/function-block
  -> 取 POU
  -> sanitizePou
  -> computedFilePath = projectPath/pous/{typeDir}/{name}{extension}
  -> window.bridge.saveFile(filePath, pou)

device
  -> 分别保存 devices/configuration.json 和 devices/pin-mapping.json

data-type/resource/server/remote-device
  -> 保存 project.json
```

main 侧：

```text
ProjectService.saveFile(filePath, content)
  -> 如果 content 是 POU
     -> serializePouToText
     -> .json 路径替换为语言扩展名
  -> 否则 JSON.stringify(content)
```

## 15. 编译入口

工作区左侧 ActivityBar：

```text
src/renderer/components/_organisms/workspace-activity-bar/default.tsx
```

Compile 按钮：

```text
DownloadButton.onClick
  -> verifyAndCompile()
```

调用链：

```text
verifyAndCompile
  -> 如果 editingState === 'unsaved'
     -> saveProject(...)
     -> handleRequest()
  -> 否则 handleRequest()
```

`handleRequest`：

```text
1. boardCore = availableBoards.get(deviceBoard)?.core || null
2. preprocessPous(projectData, isCurrentBoardSimulator, addLog)
3. runtimeIpAddress = deviceDefinitions.configuration.runtimeIpAddress || null
4. runtimeJwtToken = runtimeConnection.jwtToken || null
5. window.bridge.runCompileProgram([...], callback)
```

参数：

```text
[
  projectMeta.path,
  deviceDefinitions.configuration.deviceBoard,
  boardCore,
  compileOnly,
  processedProjectData,
  runtimeIpAddress,
  runtimeJwtToken,
]
```

## 16. 编译 IPC 链路

renderer bridge：

```text
src/main/modules/ipc/renderer.ts
```

```ts
runCompileProgram(args, callback) {
  const { port1, port2 } = new MessageChannel()
  ipcRenderer.postMessage('compiler:run-compile-program', args, [port2])
  port1.onmessage = (event) => callback(event.data)
}
```

这里不用 `invoke`，而是 `postMessage + MessageChannel`，原因是编译过程持续输出日志，需要流式回传。

main 注册：

```text
src/main/modules/ipc/main.ts
```

```text
ipcMain.on('compiler:run-compile-program', this.handleRunCompileProgram)
```

handler：

```text
handleRunCompileProgram(event, args)
  -> const mainProcessPort = event.ports[0]
  -> compilerModule.compileProgram(args, mainProcessPort, this)
```

## 17. CompilerModule.compileProgram 主流程

文件：

```text
src/main/modules/compiler/compiler-module.ts
```

入口：

```text
compileProgram(args, _mainProcessPort, mainProcessBridge)
```

参数拆解：

```text
projectPath
boardTarget
boardCore
compileOnly
projectData
runtimeIpAddress
runtimeJwtToken
```

路径准备：

```text
boardRuntime = #getBoardRuntime(boardTarget)
halsContent = read hals.json
normalizedProjectPath = projectPath.replace('project.json', '')
compilationPath = normalizedProjectPath/build/boardTarget
sourceTargetFolderPath = compilationPath/src
```

核心步骤：

```text
Step 0. 打印 host 信息，检查 Runtime v4 特性是否被非 v4 target 使用
Step 1. checkArduinoCliAvailability + checkIec2cAvailability
Step 2. createBasicDirectories
Step 3. handleGenerateXMLfromJSON
Step 4. handleTranspileXMLtoST
Step 5. copyStaticFiles
Step 6. handleTranspileSTtoC
Step 7. handleGenerateDebugFiles
Step 8. 从 program.st 提取 MD5
Step 9. handleGenerateGlueVars
Step 10. handleGenerateCBlocksHeader
Step 11. handleGenerateCBlocksCode
Step 12. Runtime v3 时 embedCBlocksInProgramSt
Step 13. 根据 boardRuntime 分支处理
```

## 18. JSON 到 XML

函数：

```text
handleGenerateXMLfromJSON(sourceTargetFolderPath, projectData)
```

调用：

```text
XmlGenerator(projectData, 'old-editor')
CreateXMLFile(sourceTargetFolderPath, xmlData, 'plc')
```

产物：

```text
build/{boardTarget}/src/plc.xml
```

XML generator 相关：

```text
src/utils/PLC/xml-generator/*
```

## 19. XML 到 ST

函数：

```text
handleTranspileXMLtoST(generatedXMLFilePath, handleOutputData)
```

调用外部工具：

```text
xml2st --generate-st build/{boardTarget}/src/plc.xml
```

产物：

```text
build/{boardTarget}/src/program.st
```

## 20. ST 到 C

函数：

```text
handleTranspileSTtoC(generatedSTFilePath, handleOutputData)
```

调用外部工具：

```text
iec2c -f -p -i -l program.st
```

产物在：

```text
build/{boardTarget}/src/
```

包括 MatIEC 生成的 C 文件。

## 21. Debug / Glue / C Blocks

Debug 文件：

```text
handleGenerateDebugFiles
  -> xml2st --generate-debug program.st VARIABLES.csv
  -> debug.c
```

Glue vars：

```text
handleGenerateGlueVars
  -> xml2st --generate-gluevars LOCATED_VARIABLES.h
```

C/C++ blocks：

```text
handleGenerateCBlocksHeader
  -> generateCBlocksHeader(projectData)

handleGenerateCBlocksCode
  -> generateCBlocksCode(projectData)
```

相关 utils：

```text
src/utils/cpp/generateCBlocksHeader.ts
src/utils/cpp/generateCBlocksCode.ts
```

## 22. Runtime v4 生成压缩包链路

当：

```text
boardRuntime === 'openplc-compiler'
boardTarget !== 'OpenPLC Runtime v3'
compileOnly === false
runtimeIpAddress && runtimeJwtToken
```

进入 Runtime v4 上传分支。

步骤：

```text
cleanConfFolder(sourceTargetFolderPath)
  -> 删除旧 conf，避免 stale config

handleGenerateModbusSlaveConfig
  -> projectData.servers -> conf/modbus_slave.json

handleGenerateModbusMasterConfig
  -> projectData.remoteDevices -> conf/modbus_master.json

handleGenerateS7CommConfig
  -> projectData.servers -> conf/s7comm.json

handleGenerateOpcUaConfig
  -> projectData.servers + debug.c + instances -> conf/opcua.json

compressSourceFolder(sourceTargetFolderPath)
  -> JSZip 打包整个 src
  -> 返回 zipBuffer

filename = 'program.zip'
contentType = 'application/zip'
```

压缩函数：

```text
compressSourceFolder(sourceFolderPath)
  -> new JSZip()
  -> addFilesToZip(currentPath, zip, relativePath)
  -> zip.generateAsync({ type: 'nodebuffer' })
```

也就是说 Runtime v4 最终上传的压缩包不是直接从项目根目录压缩，而是压缩：

```text
project-root/build/{boardTarget}/src
```

里面包括：

```text
plc.xml
program.st
debug.c
LOCATED_VARIABLES.h
MatIEC/C 相关源码
conf/*.json
C/C++ block 文件
```

## 23. Runtime v4 上传链路

上传逻辑仍在 `CompilerModule.compileProgram` 中。

请求：

```text
POST https://{runtimeIpAddress}:8443/api/upload-file
Authorization: Bearer {runtimeJwtToken}
Content-Type: multipart/form-data
file: program.zip
```

代码逻辑：

```text
boundary = '----WebKitFormBoundary' + random
header = Content-Disposition: form-data; name="file"; filename="program.zip"
body = header + fileBuffer + footer
https.request(...)
```

成功后：

```text
message: Program uploaded successfully to runtime.
parse response CompilationStatus
pollCompilationStatus()
```

轮询：

```text
GET /api/compilation-status
  -> status/logs/exit_code
  -> 把 runtime 编译日志增量发回 renderer console
  -> SUCCESS 或 FAILED 后停止
```

最后再尝试：

```text
GET /api/status
  -> parsePlcStatus
  -> 通过 MessagePort 发 plcStatus 给 renderer
  -> renderer 更新 runtimeConnection.plcStatus
```

## 24. Runtime v3 和 Arduino/Simulator 的区别

Runtime v3：

```text
boardTarget === 'OpenPLC Runtime v3'
  -> 上传 program.st
  -> filename = 'program.st'
  -> contentType = 'text/plain'
```

Runtime v4：

```text
boardTarget !== 'OpenPLC Runtime v3'
  -> 生成 conf
  -> 压缩 src 为 program.zip
  -> 上传 program.zip
```

Arduino：

```text
boardRuntime !== 'openplc-compiler'
  -> handlePatchGeneratedFiles
  -> handleCoreInstallation
  -> handleLibraryInstallation
  -> handleGenerateDefinitionsFile
  -> handleGenerateArduinoCppFile
  -> handleCompileArduinoProgram
  -> 如果 !compileOnly，handleUploadProgram
```

Simulator：

```text
boardRuntime === 'simulator'
  -> 编译 Arduino 固件
  -> 返回 simulatorFirmwarePath
  -> renderer 调用 simulatorLoadFirmware(hexPath)
```

## 25. 业务链路文件职责速查

```text
src/renderer/screens/start-screen.tsx
  启动页入口，新建/打开项目。

src/renderer/components/_features/[start]/new-project/*
  新建项目三步弹窗。

src/renderer/store/slices/shared/index.ts
  创建项目、打开项目、打开文件、保存项目、保存文件、创建 POU 等跨 slice 业务动作。

src/renderer/store/slices/project/slice.ts
  PLC 项目数据增删改。

src/renderer/store/slices/editor/slice.ts
  当前 editor model 管理。

src/renderer/store/slices/tabs/slice.ts
  tab 管理。

src/renderer/components/_organisms/explorer/project.tsx
  项目树，点击文件打开 editor。

src/renderer/screens/workspace-screen.tsx
  根据 editor.type 渲染具体编辑器。

src/main/modules/ipc/renderer.ts
  renderer bridge，发起 project/save/compiler IPC。

src/main/modules/ipc/main.ts
  main IPC handler，转发给 ProjectService/CompilerModule。

src/main/services/project-service/index.ts
  项目创建、打开、保存文件落盘。

src/main/services/project-service/utils/create-project.ts
  创建默认项目结构。

src/main/modules/compiler/compiler-module.ts
  编译总流程、Runtime v4 program.zip 生成和上传。

src/utils/PLC/xml-generator/*
  project JSON -> PLC XML。

src/utils/PLC/pou-text-serializer.ts
  POU 对象 -> 文本文件。

src/utils/PLC/pou-text-parser.ts
  文本文件 -> POU 对象。
```

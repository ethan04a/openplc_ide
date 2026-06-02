# 02. CSS 加载调用链

本文说明 OpenPLC Editor 的 CSS 是如何从入口被加载到页面、不同界面如何拿到样式、Tailwind 和普通 CSS 如何经过 Webpack 处理。

## 1. 总览

这个项目的样式体系不是“每个页面一个 CSS 文件”。主要模式是：

```text
App.tsx 全局引入基础 CSS
  -> Tailwind utility class 写在组件 className 上
  -> globals.css 定义全局变量、基础样式、组件级工具类、滚动条、Monaco/Radix z-index
  -> React Flow 局部封装额外引入 style.css
  -> Webpack 根据 dev/prod 用不同方式注入或抽取 CSS
```

主样式入口：

```text
src/renderer/App.tsx
```

```tsx
import '@xyflow/react/dist/style.css'
import 'tailwindcss/tailwind.css'
import './styles/globals.css'
```

额外局部样式：

```text
src/renderer/components/_atoms/react-flow/index.tsx
  -> import './style.css'
```

## 2. HTML 到 CSS 的整体链路

HTML 模板：

```text
src/renderer/index.ejs
```

它只提供基础 HTML、字体链接和 `#root`：

```html
<div class="h-full bg-neutral-50 text-gray-500 dark:bg-neutral-950 dark:text-gray-400" id="root"></div>
```

注意：模板里没有手写 `<link rel="stylesheet">` 指向项目 CSS。CSS 是由 Webpack 从 JS/TS import 图里发现并处理的。

完整链路：

```text
mainWindow.loadURL(index.html)
  -> index.html 加载 renderer bundle
  -> renderer/index.tsx import App
  -> App.tsx import 全局 CSS
  -> Webpack css-loader/postcss-loader/sass-loader 处理 CSS
  -> dev: style-loader 注入 <style>
  -> prod: MiniCssExtractPlugin 抽成 style.css 并由 HtmlWebpackPlugin 注入
```

## 3. App.tsx 的三个全局 CSS import

文件：

```text
src/renderer/App.tsx
```

顺序：

```tsx
import '@xyflow/react/dist/style.css'
import 'tailwindcss/tailwind.css'
import './styles/globals.css'
```

### 3.1 `@xyflow/react/dist/style.css`

来源：

```text
node_modules/@xyflow/react/dist/style.css
```

作用：

```text
给 React Flow 图形编辑器提供基础样式。
包括 react-flow 容器、节点、边、controls、background、handle 等基础 class。
```

会影响的界面：

```text
GraphicalEditor
  -> Ladder editor
  -> FBD editor
  -> ReactFlowPanel
```

虽然 StartScreen、DeviceEditor 等页面也会加载这份 CSS，因为它是 App 级全局 import，但实际使用它的是图形编辑器相关组件。

### 3.2 `tailwindcss/tailwind.css`

来源：

```text
node_modules/tailwindcss/tailwind.css
```

作用：

```text
引入 Tailwind 的基础 CSS 入口。
项目组件大量使用 className 的 Tailwind utility。
```

典型组件写法：

```tsx
className='flex h-full w-full bg-brand-dark dark:bg-neutral-950'
```

项目中绝大多数界面样式来自 Tailwind class，而不是局部 CSS 文件。

### 3.3 `./styles/globals.css`

文件：

```text
src/renderer/styles/globals.css
```

作用：

```text
1. 引入 Tailwind layers
2. 定义 CSS 变量
3. 定义滚动条
4. 定义 html/body 根布局规则
5. 定义 titlebar 相关全局 class
6. 定义常用组件类 .box
7. 定义工具类 .press-animated / .no-drag-window
8. 修正 ApexCharts、Monaco、Radix 的局部层级问题
```

开头：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

这让 `globals.css` 成为项目 Tailwind 基础层的主入口。

## 4. globals.css 具体职责

### 4.1 CSS 变量

定义在：

```css
@layer base {
  :root {
    --primary-default: #0464fb;
    --primary-light: #b4d0fe;
    --primary-medium: #0350c9;
    --primary-medium-dark: #023c97;
    --primary-dark: #011e4b;
    --oplc-title-bar-height: 2rem;
    --fallback-darwin-title-bar-height: 1.75rem;
    --radix-popper-transform-origin: 100% 0px;
    --app-vh: 100vh;
  }
}
```

被使用的地方包括：

```text
AppLayout
  -> top-[--oplc-title-bar-height]

TitleBar 相关组件
  -> 自定义 titlebar 高度

Tailwind theme
  -> brand 色值通常映射到这些 primary 变量或同色体系
```

### 4.2 根布局和防滚动

```css
html {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

body {
  user-select: none;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
```

这说明该应用按桌面 IDE 设计，不希望整个 body 滚动，而是让内部 panel 自己滚动。

### 4.3 输入可选中文本

全局禁用选择后，又给输入区域恢复：

```css
input,
textarea,
[contenteditable='true'] {
  user-select: text;
}
```

所以普通 UI 文案不能被选中，输入框、textarea、contenteditable 可以选中。

### 4.4 自定义 titlebar 类

```css
.oplc-titlebar-container
.oplc-titlebar-content
.oplc-titlebar-drag-region
.oplc-main-content
```

这些 class 服务于 Electron 无边框窗口。主进程中 `BrowserWindow` 在 Windows/macOS 配置了 `frame: false` 或隐藏 titlebar，所以 renderer 里需要自定义标题栏和拖拽区域。

### 4.5 `.box` 组件类

```css
.box {
  @apply border border-brand-light shadow-oplc dark:border-brand-medium-dark dark:shadow-oplc-dark;
}
```

这个类在 Popover、卡片、创建元素浮层等组件里复用，属于项目级轻量组件样式。

### 4.6 Monaco 和 Radix 层级修正

```css
.oplc-monaco-wrapper .monaco-editor .sticky-widget {
  z-index: 1 !important;
}

.oplc-monaco-wrapper .monaco-editor .suggest-widget,
.oplc-monaco-wrapper .monaco-editor .monaco-hover,
.oplc-monaco-wrapper .monaco-editor .parameter-hints-widget {
  z-index: 10 !important;
}

[data-radix-popper-content-wrapper],
[data-radix-select-content],
[role='listbox'] {
  z-index: 1000 !important;
}
```

这说明项目曾遇到 Monaco 的 sticky/suggest/hover 覆盖弹窗或 Radix Select 的问题，所以在全局 CSS 里压低 Monaco、抬高 Radix。

## 5. React Flow 局部 CSS 调用链

文件：

```text
src/renderer/components/_atoms/react-flow/index.tsx
src/renderer/components/_atoms/react-flow/style.css
```

调用链：

```text
GraphicalEditor
  -> Ladder/FBD editor
  -> ReactFlowPanel
  -> import './style.css'
  -> style.css 覆盖 .react-flow / .react-flow__controls / .react-flow__controls-button
```

`ReactFlowPanel` 封装：

```tsx
<ReactFlow deleteKeyCode={getDeleteKeyCodes()} {...viewportConfig}>
  {background && <Background {...backgroundConfig} />}
  {controls && <Controls {...controlsConfig}>...</Controls>}
  {children}
</ReactFlow>
```

`style.css` 主要内容：

```css
.react-flow {
  --xy-controls-button-background-color-default: #f5f5f5;
  --xy-controls-button-background-color-hover-default: #e0e0e0;
  --xy-controls-button-border-color-default: #d0d0d0;
  border: none
}

@media (prefers-color-scheme: dark) {
  .react-flow {
    --xy-controls-button-background-color-default: #2e3038;
    ...
  }
}

.react-flow__controls {
  gap: 0.2rem;
  box-shadow: none;
}

.react-flow__controls-button {
  border-radius: 25%;
}
```

使用 `ReactFlowPanel` 的地方：

```text
src/renderer/components/_molecules/graphical-editor/fbd/index.tsx
src/renderer/components/_molecules/graphical-editor/ladder/rung/body.tsx
```

所以 Ladder/FBD 图形编辑器的样式来源是三层：

```text
@xyflow/react/dist/style.css
  -> React Flow 默认基础样式

src/renderer/components/_atoms/react-flow/style.css
  -> 项目对 React Flow 控件的覆盖

组件自身 className
  -> Tailwind 布局和项目色彩
```

## 6. 各主要界面对应 CSS 来源

### 6.1 StartScreen

文件：

```text
src/renderer/screens/start-screen.tsx
src/renderer/components/_templates/[start]/main-content.tsx
src/renderer/components/_templates/[start]/side-content.tsx
src/renderer/components/_features/[start]/menu/*
src/renderer/components/_organisms/display-recent-projects/*
src/renderer/components/_organisms/project-filter-bar/*
```

CSS 来源：

```text
1. App.tsx 全局 Tailwind
2. globals.css
3. 组件 className 中的 Tailwind utility
```

没有独立 `start-screen.css`。

### 6.2 AppLayout 和 TitleBar

文件：

```text
src/renderer/components/_templates/app-layout.tsx
src/renderer/components/_organisms/title-bar/*
```

CSS 来源：

```text
1. globals.css 中的 --oplc-title-bar-height
2. globals.css 中的 oplc-titlebar-* 类
3. 组件 className 中的 Tailwind utility
```

### 6.3 WorkspaceScreen

文件：

```text
src/renderer/screens/workspace-screen.tsx
src/renderer/components/_templates/[workspace]/*
src/renderer/components/_organisms/workspace-activity-bar/*
src/renderer/components/_organisms/explorer/*
src/renderer/components/_organisms/navigation/*
src/renderer/components/_organisms/console/*
```

CSS 来源：

```text
1. App.tsx 全局 Tailwind
2. globals.css
3. 大量组件内 Tailwind className
4. Radix Tabs 通过 data-state + Tailwind className 控制 active/inactive
```

例如 Console panel 里 Tabs Trigger 使用：

```text
data-[state=active]:bg-blue-500
data-[state=active]:text-white
```

这类样式靠 Tailwind 的 arbitrary variants 生成。

### 6.4 Monaco 文本编辑器

文件：

```text
src/renderer/components/_features/[workspace]/editor/monaco/index.tsx
src/renderer/components/_features/[workspace]/editor/monaco/configs/themes/openplc/openplc.ts
src/renderer/components/_features/[workspace]/editor/monaco/configs/themes/openplc/openplc.register.ts
```

CSS 来源：

```text
1. Monaco 自身由 @monaco-editor/react 和 MonacoEditorWebpackPlugin 加载
2. 项目通过 Monaco theme config 注册 openplc 主题
3. Monaco 外层布局和容器由 Tailwind className 控制
4. globals.css 调整 Monaco overlay z-index
```

这不是普通 CSS 文件方式，而是 Monaco API 注册主题加组件 className 的组合。

### 6.5 Ladder/FBD 图形编辑器

文件：

```text
src/renderer/components/_features/[workspace]/editor/graphical/*
src/renderer/components/_molecules/graphical-editor/*
src/renderer/components/_atoms/react-flow/*
```

CSS 来源：

```text
1. @xyflow/react/dist/style.css
2. src/renderer/components/_atoms/react-flow/style.css
3. 组件 Tailwind className
4. 节点图形多用 TSX/SVG/icon 组件而不是 CSS 文件
```

### 6.6 DeviceEditor / Runtime 配置页

文件：

```text
src/renderer/components/_features/[workspace]/editor/device/index.tsx
src/renderer/components/_features/[workspace]/editor/device/configuration/board.tsx
src/renderer/components/_features/[workspace]/editor/device/configuration/communication.tsx
```

CSS 来源：

```text
1. Tailwind utility
2. globals.css 基础变量和滚动条
3. Radix Select/Popover 组件通过 className 和 globals.css z-index 修正
```

### 6.7 Modals

文件：

```text
src/renderer/components/_organisms/modals/*
src/renderer/components/_molecules/*
```

CSS 来源：

```text
1. Radix Dialog 底层行为
2. 项目 Modal/ModalContent 组件 className
3. globals.css 中 Radix popper/listbox z-index 修正
4. Tailwind utility
```

弹窗本身通常没有独立 CSS 文件。

## 7. Webpack 开发环境 CSS 链路

文件：

```text
configs/webpack/webpack.config.renderer.dev.ts
```

开发环境 entry：

```ts
entry: [
  `webpack-dev-server/client?http://localhost:${port}/dist`,
  'webpack/hot/only-dev-server',
  join(webpackPaths.srcRendererPath, 'index.tsx'),
]
```

普通 CSS rule：

```ts
{
  test: /\.s?css$/,
  use: [
    'style-loader',
    'css-loader',
    'sass-loader',
    {
      loader: 'postcss-loader',
      options: {
        postcssOptions: {
          plugins: [tailwindcss, autoprefixer],
        },
      },
    },
  ],
  exclude: /\.module\.s?(c|a)ss$/,
}
```

开发环境处理链路：

```text
App.tsx import css
  -> css-loader 解析 @import/url
  -> sass-loader 支持 scss/sass
  -> postcss-loader 运行 tailwindcss/autoprefixer
  -> style-loader 把结果插入页面 <style>
```

CSS Modules rule：

```ts
{
  test: /\.s?(c|a)ss$/,
  use: [
    'style-loader',
    {
      loader: 'css-loader',
      options: {
        modules: true,
        sourceMap: true,
        importLoaders: 1,
      },
    },
    'sass-loader',
  ],
  include: /\.module\.s?(c|a)ss$/,
}
```

项目当前核心界面基本没有依赖 `.module.css`，但配置是支持的。

## 8. Webpack 生产环境 CSS 链路

文件：

```text
configs/webpack/webpack.config.renderer.prod.ts
```

生产环境普通 CSS rule：

```ts
{
  test: /\.s?(a|c)ss$/,
  use: [
    MiniCssExtractPlugin.loader,
    'css-loader',
    'sass-loader',
    {
      loader: 'postcss-loader',
      options: {
        postcssOptions: {
          plugins: [tailwindcss, autoprefixer],
        },
      },
    },
  ],
  exclude: /\.module\.s?(c|a)ss$/,
}
```

抽取插件：

```ts
new MiniCssExtractPlugin({
  filename: 'style.css',
})
```

生产环境处理链路：

```text
App.tsx import css
  -> css-loader
  -> sass-loader
  -> postcss-loader(tailwindcss/autoprefixer)
  -> MiniCssExtractPlugin.loader
  -> 输出 dist/renderer/style.css
  -> HtmlWebpackPlugin 注入到 index.html
```

生产环境还使用：

```text
CssMinimizerPlugin
  -> 压缩 CSS
```

## 9. Tailwind 配置如何参与

配置文件：

```text
tailwind.config.ts
```

它定义项目颜色、字体、阴影等 Tailwind token。组件里类似：

```text
bg-brand
bg-brand-dark
text-neutral-850
shadow-oplc
font-caption
font-display
```

这些不是浏览器原生 class，而是 Tailwind 编译时从配置生成的 CSS。

调用链：

```text
组件 className
  -> Tailwind 扫描源码
  -> postcss-loader 执行 tailwindcss 插件
  -> 生成实际 CSS
  -> dev 注入 style，prod 输出 style.css
```

## 10. 为什么没有每个页面单独 CSS

从代码搜索结果看，renderer 中显式 CSS import 只有：

```text
src/renderer/App.tsx
src/renderer/components/_atoms/react-flow/index.tsx
```

所以页面样式分配不是：

```text
start-screen.tsx -> start-screen.css
workspace-screen.tsx -> workspace-screen.css
device-editor.tsx -> device-editor.css
```

而是：

```text
所有页面共享 App.tsx 全局 CSS
每个组件通过 className 使用 Tailwind
特殊第三方组件 React Flow 有一份局部覆盖 CSS
Monaco 通过主题注册和全局 z-index 修正处理
```

## 11. CSS 加载顺序影响

App.tsx import 顺序很重要：

```tsx
import '@xyflow/react/dist/style.css'
import 'tailwindcss/tailwind.css'
import './styles/globals.css'
```

加载顺序：

```text
1. React Flow 默认 CSS
2. Tailwind 默认入口
3. 项目 globals.css
```

后导入的 CSS 通常在打包后顺序靠后，因此 `globals.css` 有机会覆盖前面的基础规则。ReactFlowPanel 的 `style.css` 则在对应组件模块被引入时加入 bundle，覆盖 React Flow 控件变量。

## 12. 样式问题排查入口

如果某个普通界面样式异常：

```text
1. 看组件 className
2. 查 tailwind.config.ts 是否定义对应 token
3. 查 globals.css 是否有全局覆盖
4. 查 dev/prod webpack CSS rule 是否一致
```

如果图形编辑器 React Flow 样式异常：

```text
1. 确认 App.tsx 是否引入 @xyflow/react/dist/style.css
2. 查 src/renderer/components/_atoms/react-flow/style.css
3. 查 ReactFlowPanel props 是否传入 controls/background
4. 查节点组件自身 className/SVG
```

如果弹窗、下拉框被 Monaco 盖住：

```text
1. 查 globals.css 中 Monaco z-index 修正
2. 查 [data-radix-popper-content-wrapper] 的 z-index
3. 查对应 Modal/Select/Popover 是否被放在 Portal 里
```

## 13. CSS 文件职责速查

```text
src/renderer/App.tsx
  全局 CSS import 入口。

src/renderer/styles/globals.css
  Tailwind layers、CSS 变量、滚动条、全局布局、titlebar 类、Monaco/Radix 层级修正。

src/renderer/components/_atoms/react-flow/index.tsx
  React Flow 封装组件，同时 import 局部 style.css。

src/renderer/components/_atoms/react-flow/style.css
  覆盖 React Flow controls 和暗色模式变量。

configs/webpack/webpack.config.renderer.dev.ts
  开发环境 CSS loader 链，style-loader 注入页面。

configs/webpack/webpack.config.renderer.prod.ts
  生产环境 CSS loader 链，MiniCssExtractPlugin 输出 style.css。

tailwind.config.ts
  Tailwind token、颜色、字体、阴影、扫描配置。
```

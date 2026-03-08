# 开发环境设置指南

本项目使用以下技术栈：
- **运行时**: Node.js 20+
- **包管理器**: pnpm 8+（推荐）
- **构建工具**: Vite
- **语言**: TypeScript
- **UI框架**: React

## 快速开始

### 1. 安装 Node.js

推荐使用 [nvm](https://github.com/nvm-sh/nvm) 或 [fnm](https://github.com/Schniz/fnm) 管理 Node.js 版本：

```bash
# 使用 nvm
nvm install 20
nvm use 20

# 或使用 fnm
fnm install 20
fnm use 20
```

### 2. 安装 pnpm

```bash
# 使用 npm 安装 pnpm（已配置国内镜像）
npm install -g pnpm

# 或使用独立安装脚本
# npm create pnpm@latest setup
```

### 3. 安装项目依赖

```bash
pnpm install
```

### 4. 启动开发服务器

```bash
pnpm dev
```

## 国内镜像配置

项目已预配置 `.npmrc` 文件，使用淘宝镜像源加速下载：

- npm 包镜像: `https://registry.npmmirror.com`
- Node.js 二进制: `https://npmmirror.com/mirrors/node/`
- 其他二进制包也已配置对应镜像

如需使用其他镜像源，可编辑 `.npmrc` 文件：

### 可选镜像源

```bash
# 腾讯云镜像
registry=https://mirrors.cloud.tencent.com/npm/

# 华为云镜像
registry=https://repo.huaweicloud.com/repository/npm/
```

## 项目结构

```
cyber-war/
├── doc/                    # 项目文档
│   ├── prd-v1.0.md        # 产品需求文档
│   ├── tech-design-v1.0.md # 技术设计文档
│   └── dev-plan-v1.0.md   # 开发计划
├── src/                    # 源代码（待创建）
│   ├── agents/            # Agent 实现
│   ├── components/        # React 组件
│   ├── game/              # 游戏逻辑
│   ├── utils/             # 工具函数
│   └── types/             # TypeScript 类型定义
├── public/                 # 静态资源
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .npmrc                 # npm 配置（国内镜像）
```

## 常用命令

```bash
# 开发
pnpm dev              # 启动开发服务器

# 构建
pnpm build            # 构建生产版本
pnpm preview          # 预览生产构建

# 代码质量
pnpm lint             # 运行 ESLint
pnpm test             # 运行测试
pnpm test:coverage    # 运行测试并生成覆盖率报告
```

## 浏览器兼容性

- Chrome 90+
- Firefox 90+
- Edge 90+
- Safari 15.2+（注意：Safari 的 OPFS 在 7 天无交互后可能清除数据）

## 注意事项

### Safari OPFS 数据清除

Safari 浏览器在 7 天无交互后可能清除 OPFS 数据。建议：
- 开发时使用 Chrome/Firefox
- 生产环境提示用户定期导出存档

### API Key 安全

- API Key 仅在会话内解密驻留内存
- 不写入磁盘明文
- 后端仅转发请求，不存储密钥
